import admin from 'firebase-admin';

const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
if (!raw) {
  throw new Error('Missing FIREBASE_SERVICE_ACCOUNT_JSON');
}

const serviceAccount = JSON.parse(raw);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

export default admin;
