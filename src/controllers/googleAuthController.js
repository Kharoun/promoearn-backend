const { v4: uuidv4 } = require("uuid");
const { OAuth2Client } = require("google-auth-library");
const { getDb } = require("../config/firebase");
const { buildAuthTokens } = require("../utils/jwtUtils");

const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

// ─── Helpers ──────────────────────────────────────────────────────────────────

const sanitizeUser = (user) => {
  const { passwordHash, ...safe } = user;
  return safe;
};

// ─── GOOGLE SIGN IN ───────────────────────────────────────────────────────────
/**
 * Called from Expo frontend after user completes Google OAuth.
 * Expo sends us the idToken from Google — we verify it server-side
 * then create or log in the user automatically.
 *
 * POST /api/v1/auth/google
 * Body: { idToken: string }
 */
exports.googleSignIn = async (req, res) => {
  try {
    const { idToken } = req.body;

    if (!idToken) {
      return res.status(400).json({ success: false, message: "Google ID token is required." });
    }

    // ── 1. Verify the token with Google ──────────────────────────────────────
    let ticket;
    try {
      ticket = await googleClient.verifyIdToken({
        idToken,
        audience: process.env.GOOGLE_CLIENT_ID,
      });
    } catch (err) {
      return res.status(401).json({ success: false, message: "Invalid or expired Google token. Please try again." });
    }

    const payload = ticket.getPayload();
    const { sub: googleId, email, given_name: firstName, family_name: lastName, picture: avatar, email_verified } = payload;

    if (!email_verified) {
      return res.status(401).json({ success: false, message: "Google account email is not verified." });
    }

    const db = getDb();

    // ── 2. Check if user already exists (by googleId or email) ───────────────
    let userDoc = null;
    let uid = null;

    // First try by googleId (fastest, most accurate)
    const googleSnap = await db.collection("users").where("googleId", "==", googleId).limit(1).get();

    if (!googleSnap.empty) {
      // Existing Google user — just log them in
      userDoc = googleSnap.docs[0];
      uid = userDoc.id;
      await userDoc.ref.update({ lastLoginAt: new Date(), avatar: avatar || userDoc.data().avatar });
    } else {
      // Check if they registered before with the same email (email/phone signup)
      const emailSnap = await db.collection("users").where("email", "==", email.toLowerCase()).limit(1).get();

      if (!emailSnap.empty) {
        // ── 3a. Existing user — link Google to their account ─────────────────
        userDoc = emailSnap.docs[0];
        uid = userDoc.id;
        await userDoc.ref.update({
          googleId,
          avatar: avatar || userDoc.data().avatar,
          emailVerified: true, // Google guarantees email is verified
          lastLoginAt: new Date(),
          updatedAt: new Date(),
        });
      } else {
        // ── 3b. Brand new user — auto-register them ───────────────────────────
        uid = uuidv4();
        const referralCode = `PE-${uid.split("-")[0].toUpperCase()}`;

        const newUser = {
          firstName: firstName || "User",
          lastName: lastName || "",
          fullName: `${firstName || "User"} ${lastName || ""}`.trim(),
          email: email.toLowerCase(),
          phone: null,
          username: `user_${uid.split("-")[0]}`, // temporary username, they can update later
          googleId,
          avatar,
          emailVerified: true, // trusted from Google
          phoneVerified: false,
          passwordHash: null,  // no password for Google users
          referralCode,
          referredBy: null,
          isBanned: false,
          authProvider: "google",
          createdAt: new Date(),
          updatedAt: new Date(),
          lastLoginAt: new Date(),
        };

        await db.collection("users").doc(uid).set(newUser);
        userDoc = { id: uid, data: () => newUser };
      }
    }

    const userData = { uid, ...userDoc.data() };
    const tokens = buildAuthTokens(userData);

    // Tell the frontend if this is a new user (so they can prompt for phone/username)
    const isNewUser = !googleSnap.empty ? false : !emailSnap?.empty ? false : true;

    return res.status(200).json({
      success: true,
      message: isNewUser ? "Account created with Google! 🎉" : "Welcome back! 🚀",
      data: {
        ...tokens,
        user: sanitizeUser(userData),
        isNewUser,
        // If new user, they should complete their profile (add phone, update username)
        requiresProfileCompletion: isNewUser || !userData.phone,
      },
    });
  } catch (err) {
    console.error("Google sign-in error:", err);
    return res.status(500).json({ success: false, message: "Google sign-in failed. Please try again." });
  }
};

// ─── UPDATE PROFILE (for Google users completing their profile) ───────────────
/**
 * After Google sign-in, new users may need to add their phone number
 * and set a proper username.
 *
 * PATCH /api/v1/auth/complete-profile
 * Body: { phone?, username? }
 * Auth: Bearer token required
 */
exports.completeProfile = async (req, res) => {
  try {
    const { phone, username } = req.body;
    const db = getDb();
    const updates = { updatedAt: new Date() };

    if (phone) {
      // Check phone not already taken
      const phoneSnap = await db.collection("users").where("phone", "==", phone).limit(1).get();
      if (!phoneSnap.empty && phoneSnap.docs[0].id !== req.user.uid) {
        return res.status(409).json({ success: false, message: "This phone number is already linked to another account." });
      }
      updates.phone = phone;
    }

    if (username) {
      // Check username not already taken
      const usernameSnap = await db.collection("users").where("username", "==", username.toLowerCase()).limit(1).get();
      if (!usernameSnap.empty && usernameSnap.docs[0].id !== req.user.uid) {
        return res.status(409).json({ success: false, message: "Username is already taken." });
      }
      updates.username = username.toLowerCase();
    }

    await db.collection("users").doc(req.user.uid).update(updates);

    const updatedDoc = await db.collection("users").doc(req.user.uid).get();
    const updatedUser = { uid: req.user.uid, ...updatedDoc.data() };

    return res.status(200).json({
      success: true,
      message: "Profile updated successfully!",
      data: { user: sanitizeUser(updatedUser) },
    });
  } catch (err) {
    console.error("Complete profile error:", err);
    return res.status(500).json({ success: false, message: "Failed to update profile." });
  }
};
