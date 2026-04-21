const admin = require("firebase-admin");

let db;

const initFirebase = () => {
  if (admin.apps.length) return; // prevent re-initialization

  const serviceAccount = {
    type: "service_account",
    project_id: process.env.FIREBASE_PROJECT_ID,
    private_key_id: process.env.FIREBASE_PRIVATE_KEY_ID,
    private_key: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n"),
    client_email: process.env.FIREBASE_CLIENT_EMAIL,
    client_id: process.env.FIREBASE_CLIENT_ID,
    auth_uri: process.env.FIREBASE_AUTH_URI,
    token_uri: process.env.FIREBASE_TOKEN_URI,
  };

  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });

  db = admin.firestore();
  db.settings({ 
    ignoreUndefinedProperties: true,
    preferRest: true  // uses REST instead of gRPC — fixes TLS issues
  });

  console.log("✅ Firebase Admin initialized");
};

const getDb = () => {
  if (!db) throw new Error("Firebase not initialized. Call initFirebase() first.");
  return db;
};

module.exports = { initFirebase, getDb, admin };
