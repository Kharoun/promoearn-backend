const { verifyAccessToken } = require("../utils/jwtUtils");
const { getDb } = require("../config/firebase");

const adminMiddleware = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return res.status(401).json({ success: false, message: "Unauthorized." });
    }

    const token = authHeader.split(" ")[1];
    const decoded = verifyAccessToken(token);

    const db = getDb();
    const doc = await db.collection("users").doc(decoded.uid).get();

    if (!doc.exists) {
      return res.status(401).json({ success: false, message: "User not found." });
    }

    const user = { uid: doc.id, ...doc.data() };

    if (!user.isAdmin) {
      return res.status(403).json({ success: false, message: "Access denied. Admins only." });
    }

    if (user.isBanned) {
      return res.status(403).json({ success: false, message: "Your account has been suspended." });
    }

    req.user = user;
    next();
  } catch (err) {
    return res.status(401).json({ success: false, message: "Invalid or expired token." });
  }
};

module.exports = adminMiddleware;