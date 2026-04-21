const { getDb } = require("../config/firebase");

const OTP_EXPIRY_MS = (Number(process.env.OTP_EXPIRY_MINUTES) || 10) * 60 * 1000;

/**
 * Generate a cryptographically safe 6-digit OTP.
 */
const generateOtp = () => {
  const min = 100000;
  const max = 999999;
  return String(Math.floor(Math.random() * (max - min + 1)) + min);
};

/**
 * Store OTP in Firestore under /otps/{identifier}.
 * Overwrites any existing OTP for that identifier (rate limiting is done at route level).
 *
 * @param {string} identifier - email or phone number
 * @param {string} purpose - "email_verification" | "phone_verification" | "password_reset"
 */
const storeOtp = async (identifier, purpose) => {
  const db = getDb();
  const otp = generateOtp();
  const expiresAt = new Date(Date.now() + OTP_EXPIRY_MS);

  await db
    .collection("otps")
    .doc(`${purpose}_${identifier}`)
    .set({
      otp,
      identifier,
      purpose,
      expiresAt,
      createdAt: new Date(),
      attempts: 0,
    });

  return otp;
};

/**
 * Verify an OTP from Firestore.
 * - Checks existence, expiry, and max attempts (5).
 * - Deletes the OTP doc on success.
 *
 * @returns {{ valid: boolean, error?: string }}
 */
const verifyOtp = async (identifier, purpose, submittedOtp) => {
  const db = getDb();
  const docRef = db.collection("otps").doc(`${purpose}_${identifier}`);
  const doc = await docRef.get();

  if (!doc.exists) {
    return { valid: false, error: "OTP not found or already used. Please request a new one." };
  }

  const data = doc.data();

  // Check expiry
  if (new Date() > data.expiresAt.toDate()) {
    await docRef.delete();
    return { valid: false, error: "OTP has expired. Please request a new one." };
  }

  // Check max attempts (prevent brute force)
  if (data.attempts >= 5) {
    await docRef.delete();
    return { valid: false, error: "Too many attempts. Please request a new OTP." };
  }

  // Increment attempts
  await docRef.update({ attempts: data.attempts + 1 });

  if (data.otp !== submittedOtp) {
    return { valid: false, error: `Incorrect OTP. ${4 - data.attempts} attempt(s) remaining.` };
  }

  // Valid — delete the OTP doc
  await docRef.delete();
  return { valid: true };
};

/**
 * Delete an OTP doc manually (e.g. on re-send).
 */
const deleteOtp = async (identifier, purpose) => {
  const db = getDb();
  await db.collection("otps").doc(`${purpose}_${identifier}`).delete();
};

module.exports = { generateOtp, storeOtp, verifyOtp, deleteOtp };
