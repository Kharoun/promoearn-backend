const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const { v4: uuidv4 } = require("uuid");
const { getDb } = require("../config/firebase");
const { buildAuthTokens, verifyRefreshToken, signAccessToken } = require("../utils/jwtUtils");
const { storeOtp, verifyOtp } = require("../utils/otpUtils");
const { sendVerificationEmail, sendPasswordResetEmail } = require("../services/emailService");
const { sendPhoneOtp, verifyPhoneOtp } = require("../services/smsService");
const { checkVersionGate } = require("../utils/versionCheck");
// ─── Helpers ──────────────────────────────────────────────────────────────────



const detectIdentifierType = (identifier) => {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const phoneRegex = /^\+?[1-9]\d{7,14}$/;
  if (emailRegex.test(identifier)) return "email";
  if (phoneRegex.test(identifier)) return "phone";
  return null;
};

const findUserByIdentifier = async (identifier, type) => {
  const db = getDb();
  const field = type === "email" ? "email" : "phone";
  const snapshot = await db
    .collection("users")
    .where(field, "==", identifier)
    .limit(1)
    .get();
  if (snapshot.empty) return null;
  const doc = snapshot.docs[0];
  return { uid: doc.id, ...doc.data() };
};

// ─── REGISTER ─────────────────────────────────────────────────────────────────

exports.register = async (req, res) => {
  try {
    const {
      firstName, lastName, middleName, email, phone,
      password, username, dob, gender, referralCode,
    } = req.body;

    const db = getDb();

    const uniquenessChecks = [
      db.collection("users").where("email", "==", email.toLowerCase()).limit(1).get(),
      db.collection("users").where("username", "==", username.toLowerCase()).limit(1).get(),
    ];

    if (phone) {
      uniquenessChecks.push(
        db.collection("users").where("phone", "==", phone).limit(1).get()
      );
    }

    const snapshots = await Promise.all(uniquenessChecks);
    const [emailSnap, usernameSnap, phoneSnap] = snapshots;

    if (!emailSnap.empty) {
      return res.status(409).json({ success: false, message: "An account with this email already exists." });
    }
    if (!usernameSnap.empty) {
      return res.status(409).json({ success: false, message: "Username is already taken. Please choose another." });
    }
    if (phoneSnap && !phoneSnap.empty) {
      return res.status(409).json({ success: false, message: "An account with this phone number already exists." });
    }

    let referredByUid = null;
    if (referralCode) {
      const byUsername = await db.collection("users")
        .where("username", "==", referralCode.toLowerCase().replace("@", ""))
        .limit(1).get();
      if (!byUsername.empty) {
        referredByUid = byUsername.docs[0].id;
      } else {
        const byCode = await db.collection("users")
          .where("referralCode", "==", referralCode.toUpperCase())
          .limit(1).get();
        if (!byCode.empty) referredByUid = byCode.docs[0].id;
      }
    }

    const passwordHash = await bcrypt.hash(password, 12);
    const uid = uuidv4();
    const myReferralCode = username.toLowerCase();

    const newUser = {
      firstName,
      lastName,
      middleName: middleName || null,
      fullName: `${firstName} ${lastName}`,
      email: email.toLowerCase(),
      phone: phone || null,
      username: username.toLowerCase(),
      dob,
      gender,
      passwordHash,
      referralCode: myReferralCode,
      referredBy: referredByUid,
      emailVerified: false,
      phoneVerified: false,
      isBanned: false,
      createdAt: new Date(),
      updatedAt: new Date(),
      lastLoginAt: null,
      isActivated: false,
      balance: 0,
      totalEarned: 0,
      tasksCompleted: 0,
      referralsCount: 0,
    };

    await db.collection("users").doc(uid).set(newUser);

    // In register controller, after creating the user:
try {
  const otp = await storeOtp(email, "email_verification");
  await sendVerificationEmail(email, otp, firstName);
} catch (emailErr) {
  console.error("EMAIL SEND FAILED:", emailErr); // ← add this log
  // Don't silently swallow — optionally return error or continue
}
    if (phone) {
      try {
        await sendPhoneOtp(phone);
      } catch (smsErr) {
        console.warn("SMS OTP not sent (non-fatal):", smsErr.message);
      }
    }

    return res.status(201).json({
      success: true,
      message: "Account created! Please verify your email address.",
      data: {
        uid,
        email,
        phone: phone || null,
        requiresEmailVerification: true,
        requiresPhoneVerification: !!phone,
      },
    });
  } catch (err) {
    console.error("Register error:", err.message, err.stack);
    return res.status(500).json({
      success: false,
      message: "Registration failed. Please try again.",
      debug: process.env.NODE_ENV !== "production" ? err.message : undefined,
    });
  }
};

// ─── VERIFY EMAIL OTP ─────────────────────────────────────────────────────────

exports.verifyEmail = async (req, res) => {
  try {
    const { email, otp } = req.body;
    const db = getDb();

    const result = await verifyOtp(email.toLowerCase(), "email_verification", otp);
    if (!result.valid) {
      return res.status(400).json({ success: false, message: result.error });
    }

    const snap = await db.collection("users").where("email", "==", email.toLowerCase()).limit(1).get();
    if (snap.empty) return res.status(404).json({ success: false, message: "User not found." });

    const userDoc = snap.docs[0];
    await userDoc.ref.update({ emailVerified: true, updatedAt: new Date() });

    const user = { uid: userDoc.id, ...userDoc.data(), emailVerified: true };
    const tokens = buildAuthTokens(user);

    return res.status(200).json({
      success: true,
      message: "Email verified successfully! 🎉",
      data: { ...tokens, user: sanitizeUser(user) },
    });
  } catch (err) {
    console.error("Verify email error:", err);
    return res.status(500).json({ success: false, message: "Email verification failed." });
  }
};

// ─── VERIFY PHONE OTP ─────────────────────────────────────────────────────────

exports.verifyPhone = async (req, res) => {
  try {
    const { phone, otp } = req.body;
    const db = getDb();

    const approved = await verifyPhoneOtp(phone, otp);
    if (!approved) {
      return res.status(400).json({ success: false, message: "Incorrect or expired OTP." });
    }

    const snap = await db.collection("users").where("phone", "==", phone).limit(1).get();
    if (snap.empty) return res.status(404).json({ success: false, message: "User not found." });

    const userDoc = snap.docs[0];
    await userDoc.ref.update({ phoneVerified: true, updatedAt: new Date() });

    const user = { uid: userDoc.id, ...userDoc.data(), phoneVerified: true };
    const tokens = buildAuthTokens(user);

    return res.status(200).json({
      success: true,
      message: "Phone number verified successfully! 📱",
      data: { ...tokens, user: sanitizeUser(user) },
    });
  } catch (err) {
    console.error("Verify phone error:", err);
    return res.status(500).json({ success: false, message: "Phone verification failed." });
  }
};

// ─── RESEND OTP ───────────────────────────────────────────────────────────────

exports.resendOtp = async (req, res) => {
  try {
    const { identifier, type } = req.body;
    const db = getDb();

    if (type === "email") {
      const snap = await db.collection("users").where("email", "==", identifier.toLowerCase()).limit(1).get();
      if (snap.empty) return res.status(404).json({ success: false, message: "No account with that email." });

      const user = snap.docs[0].data();
      if (user.emailVerified) return res.status(400).json({ success: false, message: "Email already verified." });

      const otp = await storeOtp(identifier.toLowerCase(), "email_verification");
      await sendVerificationEmail(identifier, otp, user.firstName);

      return res.status(200).json({ success: true, message: "Verification email resent." });
    }

    if (type === "phone") {
      const snap = await db.collection("users").where("phone", "==", identifier).limit(1).get();
      if (snap.empty) return res.status(404).json({ success: false, message: "No account with that phone number." });

      await sendPhoneOtp(identifier);
      return res.status(200).json({ success: true, message: "OTP sent to your phone." });
    }

    return res.status(400).json({ success: false, message: "type must be 'email' or 'phone'." });
  } catch (err) {
    console.error("Resend OTP error:", err);
    return res.status(500).json({ success: false, message: "Failed to resend OTP." });
  }
};

// ─── LOGIN ────────────────────────────────────────────────────────────────────

exports.login = async (req, res) => {
  try {
    const gate = await checkVersionGate(req, getDb);
    if (gate) return res.status(gate.status).json(gate.body);

    const { identifier, password } = req.body;
    const type = detectIdentifierType(identifier.trim());
    if (!type) {
      return res.status(400).json({ success: false, message: "Enter a valid email address or phone number." });
    }

    const user = await findUserByIdentifier(
      type === "email" ? identifier.toLowerCase() : identifier,
      type
    );

    if (!user) {
      return res.status(401).json({ success: false, message: "Invalid credentials. Please check and try again." });
    }

    if (user.isBanned) {
      return res.status(403).json({ success: false, message: "Your account has been suspended. Contact support." });
    }

    const passwordMatch = await bcrypt.compare(password, user.passwordHash);
    if (!passwordMatch) {
      return res.status(401).json({ success: false, message: "Invalid credentials. Please check and try again." });
    }

    const db = getDb();
    await db.collection("users").doc(user.uid).update({
      lastLoginAt:           new Date(),
      inactivityWarningSent: false,
    });
    // ...rest unchanged (tokens, warnings, response)

    const tokens = buildAuthTokens(user);

    const warnings = [];
    if (!user.emailVerified) warnings.push("email");
    if (user.phone && !user.phoneVerified) warnings.push("phone");

    return res.status(200).json({
      success: true,
      message: "Login successful! 🚀",
      data: {
        ...tokens,
        user: sanitizeUser(user),
        verificationWarnings: warnings.length > 0
          ? `Please verify your ${warnings.join(" and ")}.`
          : null,
      },
    });
  } catch (err) {
    console.error("Login error:", err);
    return res.status(500).json({ success: false, message: "Login failed. Please try again." });
  }
};

// ─── REFRESH TOKEN ────────────────────────────────────────────────────────────

exports.refreshToken = async (req, res) => {
  try {
    const { refreshToken } = req.body;
    if (!refreshToken) {
      return res.status(400).json({ success: false, message: "Refresh token required." });
    }

    const decoded = verifyRefreshToken(refreshToken);
    const db = getDb();
    const doc = await db.collection("users").doc(decoded.uid).get();

    if (!doc.exists) return res.status(401).json({ success: false, message: "User not found." });

    const user = { uid: doc.id, ...doc.data() };
    const accessToken = signAccessToken({
      uid: user.uid,
      email: user.email,
      phone: user.phone,
      username: user.username,
    });

    return res.status(200).json({
      success: true,
      data: { accessToken, expiresIn: process.env.JWT_EXPIRES_IN || "7d" },
    });
  } catch (err) {
    return res.status(401).json({ success: false, message: "Invalid or expired refresh token." });
  }
};

// ─── FORGOT PASSWORD ──────────────────────────────────────────────────────────

// ─── FORGOT PASSWORD — Send OTP ───────────────────────────────────────────
exports.forgotPassword = async (req, res) => {
  try {
    const db = getDb();
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({ success: false, message: "Email is required." });
    }

    const snap = await db.collection("users")
      .where("email", "==", email.toLowerCase().trim())
      .limit(1).get();

    // Always return success to avoid revealing whether email exists
    if (snap.empty) {
      return res.status(200).json({ success: true, message: "If this email is registered, you will receive a reset code." });
    }

    const uid  = snap.docs[0].id;
    const user = snap.docs[0].data();

    const otp = await storeOtp(email.toLowerCase().trim(), "password_reset");
    await sendPasswordResetEmail(email, otp, user.firstName || "User");

    return res.status(200).json({
      success: true,
      message: "If this email is registered, you will receive a reset code.",
    });
  } catch (err) {
    console.error("Forgot password error:", err);
    return res.status(500).json({ success: false, message: "Failed to send reset code. Please try again." });
  }
};

// ─── VERIFY RESET OTP ─────────────────────────────────────────────────────
exports.verifyResetOtp = async (req, res) => {
  try {
    const db = getDb();
    const { email, otp } = req.body;

    if (!email || !otp) {
      return res.status(400).json({ success: false, message: "Email and OTP are required." });
    }

    const result = await verifyOtp(email.toLowerCase().trim(), "password_reset", otp);
    if (!result.valid) {
      return res.status(400).json({ success: false, message: result.error });
    }

    // Generate a short-lived reset token
    const crypto = require("crypto");
    const resetToken = crypto.randomBytes(32).toString("hex");
    const tokenHash  = crypto.createHash("sha256").update(resetToken).digest("hex");

    const snap = await db.collection("users")
      .where("email", "==", email.toLowerCase().trim())
      .limit(1).get();

    if (snap.empty) {
      return res.status(404).json({ success: false, message: "User not found." });
    }

    await db.collection("users").doc(snap.docs[0].id).update({
      passwordResetToken:       tokenHash,
      passwordResetTokenExpiry: new Date(Date.now() + 10 * 60 * 1000),
      updatedAt:                new Date(),
    });

    return res.status(200).json({
      success: true,
      message: "Code verified.",
      data: { resetToken },
    });
  } catch (err) {
    console.error("Verify OTP error:", err);
    return res.status(500).json({ success: false, message: "Failed to verify code." });
  }
};

// ─── RESET PASSWORD ───────────────────────────────────────────────────────
exports.resetPassword = async (req, res) => {
  try {
    const db = getDb();
    const { email, resetToken, newPassword } = req.body;

    if (!email || !resetToken || !newPassword) {
      return res.status(400).json({ success: false, message: "All fields are required." });
    }

    if (newPassword.length < 6) {
      return res.status(400).json({ success: false, message: "Password must be at least 6 characters." });
    }

    const snap = await db.collection("users")
      .where("email", "==", email.toLowerCase().trim())
      .limit(1).get();

    if (snap.empty) {
      return res.status(400).json({ success: false, message: "Invalid request." });
    }

    const uid  = snap.docs[0].id;
    const user = snap.docs[0].data();

    const crypto = require("crypto");
    const tokenHash = crypto.createHash("sha256").update(resetToken).digest("hex");

    if (user.passwordResetToken !== tokenHash) {
      return res.status(400).json({ success: false, message: "Invalid or expired reset token." });
    }

    const expiry = user.passwordResetTokenExpiry?._seconds
      ? new Date(user.passwordResetTokenExpiry._seconds * 1000)
      : new Date(user.passwordResetTokenExpiry);

    if (new Date() > expiry) {
      return res.status(400).json({ success: false, message: "Reset session expired. Please start again." });
    }

    const passwordHash = await bcrypt.hash(newPassword, 12);

    await db.collection("users").doc(uid).update({
      passwordHash,
      passwordResetToken:       null,
      passwordResetTokenExpiry: null,
      updatedAt:                new Date(),
    });

    return res.status(200).json({
      success: true,
      message: "Password reset successfully. You can now log in.",
    });
  } catch (err) {
    console.error("Reset password error:", err);
    return res.status(500).json({ success: false, message: "Failed to reset password." });
  }
};

// ─── GET CURRENT USER ─────────────────────────────────────────────────────────

exports.getMe = async (req, res) => {
  return res.status(200).json({
    success: true,
    data: { user: sanitizeUser(req.user) },
  });
};

// ─── LOGOUT ───────────────────────────────────────────────────────────────────

exports.logout = async (req, res) => {
  return res.status(200).json({ success: true, message: "Logged out successfully." });
};

// ─── CHANGE USERNAME ──────────────────────────────────────────────────────────

exports.changeUsername = async (req, res) => {
  try {
    const { username } = req.body;
    const db = getDb();

    if (!username || typeof username !== "string") {
      return res.status(400).json({ success: false, message: "Username is required." });
    }

    const cleaned = username.toLowerCase().trim();

    // Validate format: alphanumeric + underscores, 3–20 chars
    const usernameRegex = /^[a-z0-9_]{3,20}$/;
    if (!usernameRegex.test(cleaned)) {
      return res.status(400).json({
        success: false,
        message: "Username must be 3–20 characters and contain only letters, numbers, or underscores.",
      });
    }

    // Check if it's the same as current
    if (cleaned === req.user.username) {
      return res.status(400).json({ success: false, message: "New username must be different from your current one." });
    }

    // Check uniqueness
    const snap = await db.collection("users").where("username", "==", cleaned).limit(1).get();
    if (!snap.empty) {
      return res.status(409).json({ success: false, message: "Username is already taken. Please choose another." });
    }

    await db.collection("users").doc(req.user.uid).update({
      username: cleaned,
      referralCode: cleaned, // keep referralCode in sync
      updatedAt: new Date(),
    });

    return res.status(200).json({
      success: true,
      message: "Username updated successfully.",
      data: { username: cleaned },
    });
  } catch (err) {
    console.error("Change username error:", err);
    return res.status(500).json({ success: false, message: "Failed to update username." });
  }
};

// ─── CHANGE PASSWORD ──────────────────────────────────────────────────────────

exports.changePassword = async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    const db = getDb();

    if (!currentPassword || !newPassword) {
      return res.status(400).json({ success: false, message: "Current and new password are required." });
    }

    if (newPassword.length < 8) {
      return res.status(400).json({ success: false, message: "New password must be at least 8 characters." });
    }

    // Fetch fresh user doc to get passwordHash (req.user may not include it)
    const doc = await db.collection("users").doc(req.user.uid).get();
    if (!doc.exists) return res.status(404).json({ success: false, message: "User not found." });

    const userData = doc.data();

    // Google-only accounts won't have a passwordHash
    if (!userData.passwordHash) {
      return res.status(400).json({
        success: false,
        message: "Your account uses Google sign-in and doesn't have a password to change.",
      });
    }

    const isMatch = await bcrypt.compare(currentPassword, userData.passwordHash);
    if (!isMatch) {
      return res.status(401).json({ success: false, message: "Current password is incorrect." });
    }

    // Prevent reusing the same password
    const isSame = await bcrypt.compare(newPassword, userData.passwordHash);
    if (isSame) {
      return res.status(400).json({ success: false, message: "New password must be different from your current one." });
    }

    const passwordHash = await bcrypt.hash(newPassword, 12);
    await db.collection("users").doc(req.user.uid).update({ passwordHash, updatedAt: new Date() });

    return res.status(200).json({
      success: true,
      message: "Password changed successfully. 🔐",
    });
  } catch (err) {
    console.error("Change password error:", err);
    return res.status(500).json({ success: false, message: "Failed to change password." });
  }
};
//toggle-2fa

// ─── TOGGLE 2FA ───────────────────────────────────────────────────────────────

exports.toggleTwoFA = async (req, res) => {
  try {
    const { enabled } = req.body;
    const db = getDb();

    await db.collection("users").doc(req.user.uid).update({
      twoFactorEnabled: !!enabled,
      updatedAt: new Date(),
    });

    return res.status(200).json({
      success: true,
      message: `Two-factor authentication ${enabled ? "enabled" : "disabled"}.`,
      data: { twoFactorEnabled: !!enabled },
    });
  } catch (err) {
    console.error("Toggle 2FA error:", err);
    return res.status(500).json({ success: false, message: "Failed to update 2FA setting." });
  }
};

///
exports.googleLogin = async (req, res) => {
  try {
    const db = getDb();
    const { googleId, email, firstName, lastName, picture } = req.body;

    if (!email || !googleId) {
      return res.status(400).json({ success: false, message: "Invalid Google data." });
    }

    let userSnap = await db.collection("users").where("email", "==", email).limit(1).get();
    let uid, user;

    if (!userSnap.empty) {
      uid  = userSnap.docs[0].id;
      user = userSnap.docs[0].data();
      if (!user.googleId) {
        await db.collection("users").doc(uid).update({ googleId, updatedAt: new Date() });
      }
    } else {
      const username = email.split("@")[0].toLowerCase().replace(/[^a-z0-9_]/g, "_");
      const newUser  = {
        firstName, lastName, email, googleId,
        picture:       picture || null,
        username,
        referralCode:  username,
        isActivated:   false,
        isAdmin:       false,
        isBanned:      false,
        balance:       0,
        totalEarned:   0,
        tasksCompleted: 0,
        referralsCount: 0,
        authProvider:  "google",
        createdAt:     new Date(),
        updatedAt:     new Date(),
      };
      const docRef = await db.collection("users").add(newUser);
      uid  = docRef.id;
      user = newUser;
    }

    if (user.isBanned) {
      return res.status(403).json({ success: false, message: "Account has been banned." });
    }

    // ✅ Use buildAuthTokens — already imported, no jwt needed
    const tokens = buildAuthTokens({ uid, email, phone: user.phone || null, username: user.username });

    return res.status(200).json({
      success: true,
      data: {
        accessToken:  tokens.accessToken,
        refreshToken: tokens.refreshToken,
        user: { uid, ...user },
      },
    });
  } catch (err) {
    console.error("Google login error:", err);
    return res.status(500).json({ success: false, message: "Google login failed." });
  }
};
// ─── Sanitize / Mask Helpers ──────────────────────────────────────────────────

const sanitizeUser = (user) => {
  const { passwordHash, ...safe } = user;
  return safe;
};

const maskIdentifier = (identifier, type) => {
  if (type === "email") {
    const [local, domain] = identifier.split("@");
    return `${local[0]}***@${domain}`;
  }
  return `+***${identifier.slice(-4)}`;
};
// ─── DELETE ACCOUNT ───────────────────────────────────────────────────────────
exports.deleteAccount = async (req, res) => {
  try {
    const uid = req.user?.uid;
    if (!uid) {
      return res.status(401).json({ success: false, message: "Not authenticated." });
    }

    const db = getDb();

    // Delete user document
    await db.collection("users").doc(uid).delete();

    // Clean up related data in parallel
    const cleanup = [];

    // Delete user's task completions
    const completionsSnap = await db.collection("completedTasks").where("userId", "==", uid).get();
    completionsSnap.forEach(doc => cleanup.push(doc.ref.delete()));

    // Delete user's notifications
    const notifSnap = await db.collection("notifications").where("userId", "==", uid).get();
    notifSnap.forEach(doc => cleanup.push(doc.ref.delete()));

    // Delete user's payout requests
    const payoutSnap = await db.collection("payments").where("userId", "==", uid).get();
    payoutSnap.forEach(doc => cleanup.push(doc.ref.delete()));

    await Promise.all(cleanup);

    return res.status(200).json({
      success: true,
      message: "Account permanently deleted.",
    });
  } catch (err) {
    console.error("deleteAccount error:", err);
    return res.status(500).json({ success: false, message: "Failed to delete account. Please try again." });
  }
};