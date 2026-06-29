require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const admin = require('firebase-admin');
const swaggerUi = require('swagger-ui-express');
const swaggerJsdoc = require('swagger-jsdoc');
const path = require('path');

const UserToken = require('./models/UserToken');

const app = express();
const PORT = process.env.PORT || 3000;

// Enable CORS
app.use(cors());
app.use(express.json());

// Initialize Firebase Admin SDK
try {
  const serviceAccount = {
    type: process.env.FIREBASE_TYPE || 'service_account',
    project_id: process.env.FIREBASE_PROJECT_ID,
    private_key_id: process.env.FIREBASE_PRIVATE_KEY_ID,
    private_key: process.env.FIREBASE_PRIVATE_KEY ? process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n') : undefined,
    client_email: process.env.FIREBASE_CLIENT_EMAIL,
    client_id: process.env.FIREBASE_CLIENT_ID,
    auth_uri: process.env.FIREBASE_AUTH_URI,
    token_uri: process.env.FIREBASE_TOKEN_URI,
    auth_provider_x509_cert_url: process.env.FIREBASE_AUTH_PROVIDER_X509_CERT_URL,
    client_x509_cert_url: process.env.FIREBASE_CLIENT_X509_CERT_URL,
    universe_domain: process.env.FIREBASE_UNIVERSE_DOMAIN
  };

  if (!serviceAccount.project_id || !serviceAccount.client_email || !serviceAccount.private_key) {
    throw new Error('Missing FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, or FIREBASE_PRIVATE_KEY in .env file.');
  }

  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
  console.log('Firebase Admin SDK initialized successfully from environment variables.');
} catch (error) {
  console.error('Failed to initialize Firebase Admin SDK. Notifications will fail to send:', error.message);
}

// Connect to MongoDB Atlas
mongoose.connect(process.env.MONGO_URI, {
  serverSelectionTimeoutMS: 10000,
  socketTimeoutMS: 45000,
  retryWrites: true,
})
  .then(() => console.log('✅ Connected to MongoDB Atlas database.'))
  .catch(err => {
    console.error('❌ MongoDB connection error:', err.message);
    if (err.message.includes('ReplicaSetNoPrimary') || err.message.includes('timed out')) {
      console.error('\n⚠️  ATLAS IP WHITELIST ISSUE DETECTED');
      console.error('   Your current IP address is not whitelisted in MongoDB Atlas.');
      console.error('   Fix: Go to https://cloud.mongodb.com → Network Access → Add IP Address');
      console.error('   Add your current IP or use 0.0.0.0/0 to allow all IPs (development only).\n');
    }
  });

// ─── SWAGGER CONFIGURATION ───
const swaggerOptions = {
  definition: {
    openapi: '3.0.0',
    info: {
      title: 'OminiPass FCM Notification API',
      version: '1.0.0',
      description: 'API service for registering client tokens and broadcasting push notifications using Firebase Cloud Messaging (FCM).',
    },
    servers: [
      {
        url: `http://localhost:${PORT}`,
        description: 'Local development server'
      }
    ]
  },
  apis: [__filename] // Generates docs directly from JSDoc tags in this file
};

const swaggerSpec = swaggerJsdoc(swaggerOptions);
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec));

// ─── API ROUTES & DOCUMENTATION ───

/**
 * @openapi
 * /api/fcm/register:
 *   post:
 *     summary: Register or update a user device token
 *     description: Saves the user's FCM token along with their phone and email to target notifications later.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - email
 *               - phone
 *               - fcm_token
 *             properties:
 *               email:
 *                 type: string
 *                 example: user@example.com
 *               phone:
 *                 type: string
 *                 example: "+233201234567"
 *               fcm_token:
 *                 type: string
 *                 example: "d5X_..._your_fcm_token"
 *     responses:
 *       200:
 *         description: Token successfully registered or updated
 *       400:
 *         description: Missing required fields
 *       500:
 *         description: Database error
 */
app.post('/api/fcm/register', async (req, res) => {
  const { email, phone, fcm_token } = req.body;
  
  if (!email || !phone || !fcm_token) {
    return res.status(400).json({ success: false, message: 'Missing email, phone, or fcm_token' });
  }

  try {
    // Upsert token registration: one token maps to one user (email, phone)
    const result = await UserToken.findOneAndUpdate(
      { fcmToken: fcm_token },
      { email, phone, createdAt: new Date() },
      { upsert: true, new: true }
    );
    res.json({ success: true, message: 'Token registered successfully', data: result });
  } catch (error) {
    console.error('Error registering token:', error);
    res.status(500).json({ success: false, message: 'Database error', error: error.message });
  }
});

/**
 * @openapi
 * /api/fcm/unregister:
 *   post:
 *     summary: Unregister a device token
 *     description: Deletes the FCM token mapping from the database, usually called on logout.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - fcm_token
 *             properties:
 *               fcm_token:
 *                 type: string
 *                 example: "d5X_..._your_fcm_token"
 *     responses:
 *       200:
 *         description: Token successfully removed
 *       400:
 *         description: Missing token
 *       500:
 *         description: Database error
 */
app.post('/api/fcm/unregister', async (req, res) => {
  const { fcm_token } = req.body;

  if (!fcm_token) {
    return res.status(400).json({ success: false, message: 'Missing fcm_token' });
  }

  try {
    const result = await UserToken.findOneAndDelete({ fcmToken: fcm_token });
    res.json({ success: true, message: 'Token unregistered successfully', data: result });
  } catch (error) {
    console.error('Error unregistering token:', error);
    res.status(500).json({ success: false, message: 'Database error', error: error.message });
  }
});

/**
 * @openapi
 * /api/fcm/users:
 *   get:
 *     summary: List all registered clients
 *     description: Retrieves all registered FCM tokens alongside user emails and phones.
 *     responses:
 *       200:
 *         description: A list of users and tokens
 *       500:
 *         description: Database error
 */
app.get('/api/fcm/users', async (req, res) => {
  try {
    const users = await UserToken.find().sort({ createdAt: -1 });
    res.json({ success: true, data: users });
  } catch (error) {
    console.error('Error fetching users:', error);
    res.status(500).json({ success: false, message: 'Database error', error: error.message });
  }
});

/**
 * @openapi
 * /api/fcm/users/{token}:
 *   delete:
 *     summary: Delete a token mapping by token value
 *     description: Deletes a specific client token.
 *     parameters:
 *       - in: path
 *         name: token
 *         required: true
 *         schema:
 *           type: string
 *         description: The FCM token string to delete
 *     responses:
 *       200:
 *         description: Token successfully deleted
 *       500:
 *         description: Database error
 */
app.delete('/api/fcm/users/:token', async (req, res) => {
  const { token } = req.params;

  try {
    const result = await UserToken.findOneAndDelete({ fcmToken: token });
    if (!result) {
      return res.status(404).json({ success: false, message: 'Token mapping not found' });
    }
    res.json({ success: true, message: 'Token deleted successfully', data: result });
  } catch (error) {
    console.error('Error deleting token:', error);
    res.status(500).json({ success: false, message: 'Database error', error: error.message });
  }
});

/**
 * @openapi
 * /api/fcm/send:
 *   post:
 *     summary: Send a push notification
 *     description: Broadcasts a notification payload to one user, multiple users, or all users (topic).
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - target
 *               - title
 *               - body
 *             properties:
 *               target:
 *                 type: string
 *                 enum: [single, multiple, group, all]
 *                 example: single
 *               emails:
 *                 type: array
 *                 items:
 *                   type: string
 *                 example: ["user@example.com"]
 *               phones:
 *                 type: array
 *                 items:
 *                   type: string
 *                 example: ["+233201234567"]
 *               title:
 *                 type: string
 *                 example: "OminiPass Alert!"
 *               body:
 *                 type: string
 *                 example: "Your ticket has been confirmed."
 *               category:
 *                 type: string
 *                 example: "user_notice"
 *               type:
 *                 type: string
 *                 example: "tickets"
 *               image_url:
 *                 type: string
 *                 example: "https://images.unsplash.com/photo-1514525253161-7a46d19cd819?w=600"
 *     responses:
 *       200:
 *         description: Notification broadcast successfully completed
 *       400:
 *         description: Missing fields or invalid configuration
 *       500:
 *         description: FCM transmission error
 */
app.post('/api/fcm/send', async (req, res) => {
  const { target, emails, phones, title, body, category = 'universal', type = 'universal', image_url } = req.body;

  if (!target || !title || !body) {
    return res.status(400).json({ success: false, message: 'Missing target, title, or body' });
  }

  // Base notification data payload matching App notices details schema
  const dataPayload = {
    category: String(category),
    type: String(type)
  };
  if (image_url) {
    dataPayload.image_url = String(image_url);
  }

  try {
    // ─── Scenario A: Send to all (Topic "all_users") ───
    if (target === 'all') {
      const payload = {
        topic: 'all_users',
        notification: { title, body },
        data: dataPayload
      };
      const response = await admin.messaging().send(payload);
      return res.json({ success: true, message: 'Broadcast sent to all users', fcm_response: response });
    }

    // ─── Scenario B: Group / Multicast targeting ───
    // Query tokens matching selected emails or phone numbers
    let targetTokens = [];
    const query = [];
    if (emails && Array.isArray(emails) && emails.length > 0) {
      query.push({ email: { $in: emails } });
    }
    if (phones && Array.isArray(phones) && phones.length > 0) {
      query.push({ phone: { $in: phones } });
    }

    if (query.length > 0) {
      const records = await UserToken.find({ $or: query });
      targetTokens = records.map(r => r.fcmToken);
    }

    if (targetTokens.length === 0) {
      return res.status(404).json({ success: false, message: 'No registered devices found for the specified target(s).' });
    }

    // FCM HTTP v1 SDK requires individual messaging payloads for target tokens
    const sendPromises = targetTokens.map(async (token) => {
      const payload = {
        token: token,
        notification: { title, body },
        data: dataPayload
      };
      return admin.messaging().send(payload);
    });

    const results = await Promise.allSettled(sendPromises);
    const succeeded = results.filter(r => r.status === 'fulfilled').length;
    const failed = results.filter(r => r.status === 'rejected').length;

    res.json({
      success: true,
      message: `Notification broadcast summary: ${succeeded} succeeded, ${failed} failed.`,
      devices_targeted: targetTokens.length,
      details: results
    });

  } catch (error) {
    console.error('FCM transmission error:', error);
    res.status(500).json({ success: false, message: 'FCM transmission error', error: error.message });
  }
});

// Start backend server
app.listen(PORT, () => {
  console.log(`\n======================================================`);
  console.log(`  OminiPass FCM Notification Backend Server Started`);
  console.log(`  Port: ${PORT}`);
  console.log(`  Interactive API Docs: http://localhost:${PORT}/api-docs`);
  console.log(`======================================================\n`);
});
