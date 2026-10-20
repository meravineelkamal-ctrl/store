require('dotenv').config();

const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const { S3Client, GetObjectCommand, PutObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const axios = require('axios');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

const firebasePrivateKey = process.env.FIREBASE_PRIVATE_KEY
  ? process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n')
  : null;

if (!process.env.FIREBASE_PROJECT_ID || !process.env.FIREBASE_CLIENT_EMAIL || !firebasePrivateKey) {
  console.warn('Firebase environment variables are missing. Check .env before starting the server.');
}

admin.initializeApp({
  credential: admin.credential.cert({
    projectId: process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey: firebasePrivateKey,
  }),
});

const db = admin.firestore();

const s3 = new S3Client({
  endpoint: `https://${process.env.B2_ENDPOINT}`,
  region: process.env.B2_REGION || 'us-east-005',
  credentials: {
    accessKeyId: process.env.B2_KEY_ID,
    secretAccessKey: process.env.B2_APPLICATION_KEY,
  },
  forcePathStyle: true,
});

const isAdmin = (email) => {
  const adminEmails = (process.env.ADMIN_EMAILS || '')
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);

  return !!email && adminEmails.includes(email.toLowerCase());
};

async function verifyToken(req, res, next) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;

  if (!token) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    req.user = await admin.auth().verifyIdToken(token);
    return next();
  } catch (error) {
    console.error('Token verification failed:', error.message);
    return res.status(401).json({ error: 'Invalid token' });
  }
}

app.get('/health', (req, res) => {
  res.status(200).json({ ok: true, service: 'neelkamal-backend' });
});

app.post('/api/payment/create', verifyToken, async (req, res) => {
  try {
    const { bookId } = req.body || {};

    if (!bookId) {
      return res.status(400).json({ error: 'Book ID is required' });
    }

    const bookDoc = await db.collection('pdf-store-files').doc(bookId).get();
    if (!bookDoc.exists) {
      return res.status(404).json({ error: 'Book not found' });
    }

    const book = bookDoc.data();
    const orderId = `ORD_${Date.now()}_${req.user.uid.slice(0, 6)}`;

    await db.collection('orders').doc(orderId).set({
      userId: req.user.uid,
      bookId,
      amount: Number(book.price || 0),
      status: 'pending',
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    const paymentPayload = {
      mid: process.env.TRANZUPI_MERCHANT_ID,
      amount: Number(book.price || 0),
      orderId,
      customerName: req.user.name || req.user.email || 'Customer',
      customerEmail: req.user.email,
      callbackUrl: process.env.TRANZUPI_CALLBACK_URL,
      redirectUrl: process.env.FRONTEND_URL,
    };

    const response = await axios.post(
      'https://api.upitranzact.com/v1/payments/createPaymentLink',
      paymentPayload,
      {
        headers: {
          Authorization: process.env.TRANZUPI_AUTH_HEADER || '',
          'Content-Type': 'application/json',
        },
      }
    );

    const paymentUrl = response.data?.data?.paymentUrl || response.data?.paymentUrl;
    if (!paymentUrl) {
      throw new Error('Payment URL not generated');
    }

    return res.json({ paymentUrl });
  } catch (error) {
    console.error('Payment Error:', error.response?.data || error.message);
    return res.status(500).json({ error: 'Payment initiation failed' });
  }
});

app.post('/api/payment/callback', async (req, res) => {
  try {
    const { txnStatus, orderId } = req.body || {};

    if (!orderId) {
      return res.status(400).send('Missing Order ID');
    }

    const orderRef = db.collection('orders').doc(orderId);
    const orderSnap = await orderRef.get();

    if (!orderSnap.exists) {
      return res.status(404).send('Order Not Found');
    }

    const orderData = orderSnap.data();

    if (txnStatus === 'SUCCESS' || txnStatus === 'TXN_SUCCESS') {
      await orderRef.update({ status: 'completed' });

      await db
        .collection('users')
        .doc(orderData.userId)
        .collection('purchases')
        .doc(orderData.bookId)
        .set({
          bookId: orderData.bookId,
          orderId,
          purchasedAt: admin.firestore.FieldValue.serverTimestamp(),
          status: 'completed',
        });
    } else {
      await orderRef.update({ status: 'failed' });
    }

    return res.status(200).send('OK');
  } catch (error) {
    console.error('Webhook Error:', error);
    return res.status(500).send('Webhook failed');
  }
});

app.get('/api/download/:bookId', verifyToken, async (req, res) => {
  try {
    const { bookId } = req.params;

    const purchaseSnap = await db
      .collection('users')
      .doc(req.user.uid)
      .collection('purchases')
      .doc(bookId)
      .get();

    if (!purchaseSnap.exists) {
      return res.status(403).json({ error: 'Purchase required' });
    }

    const bookDoc = await db.collection('pdf-store-files').doc(bookId).get();
    const book = bookDoc.data();

    if (!book || !book.pdfPath) {
      return res.status(500).json({ error: 'PDF path missing' });
    }

    const command = new GetObjectCommand({
      Bucket: process.env.B2_BUCKET_NAME,
      Key: book.pdfPath,
    });

    const signedUrl = await getSignedUrl(s3, command, { expiresIn: 300 });
    return res.json({ downloadUrl: signedUrl });
  } catch (error) {
    console.error('Download Error:', error);
    return res.status(500).json({ error: 'Download failed' });
  }
});

app.post('/api/admin/presigned-upload', verifyToken, async (req, res) => {
  if (!isAdmin(req.user.email)) {
    return res.status(403).json({ error: 'Access Denied: Admin only' });
  }

  try {
    const { fileName, contentType } = req.body || {};

    if (!fileName || !contentType) {
      return res.status(400).json({ error: 'fileName and contentType are required' });
    }

    const key = `pdfs/${Date.now()}-${fileName.replace(/\s+/g, '-')}`;

    const command = new PutObjectCommand({
      Bucket: process.env.B2_BUCKET_NAME,
      Key: key,
      ContentType: contentType,
    });

    const uploadUrl = await getSignedUrl(s3, command, { expiresIn: 600 });
    return res.json({ uploadUrl, key });
  } catch (error) {
    console.error('Presigned upload error:', error);
    return res.status(500).json({ error: 'Failed to create upload URL' });
  }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`NEELKAMAL Server running on port ${PORT}`);
});
