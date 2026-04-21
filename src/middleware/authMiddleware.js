const { verifyAccessToken } = require("../utils/jwtUtils");
const { getDb } = require("../config/firebase");

/**
 * Protect routes: validates JWT and attaches user to req.user.
 */
const protect = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return res.status(401).json({
        success: false,
        message: "Access denied. No token provided.",
      });
    }

    const token = authHeader.split(" ")[1];
    const decoded = verifyAccessToken(token);

    // Optionally verify user still exists in Firestore
    const db = getDb();
    const userDoc = await db.collection("users").doc(decoded.uid).get();

    if (!userDoc.exists) {
      return res.status(401).json({
        success: false,
        message: "User no longer exists.",
      });
    }

    const userData = userDoc.data();

    if (userData.isBanned) {
      return res.status(403).json({
        success: false,
        message: "Your account has been suspended. Contact support.",
      });
    }

    req.user = { uid: decoded.uid, ...userData };
    next();
  } catch (err) {
    if (err.name === "TokenExpiredError") {
      return res.status(401).json({
        success: false,
        message: "Session expired. Please log in again.",
        code: "TOKEN_EXPIRED",
      });
    }
    return res.status(401).json({
      success: false,
      message: "Invalid token.",
    });
  }
};

/**
 * Optional: restrict to verified users only.
 */
const requireVerified = (req, res, next) => {
  if (!req.user.emailVerified && !req.user.phoneVerified) {
    return res.status(403).json({
      success: false,
      message: "Please verify your email or phone number to continue.",
      code: "UNVERIFIED",
    });
  }
  next();
};

module.exports = { protect, requireVerified };
