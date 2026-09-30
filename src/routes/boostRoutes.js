/**
 * routes/boostRoutes.js — mount at /api/v1/boost
 * If you already have a shared auth middleware, swap verifyToken for it.
 */
const express = require("express");
const jwt = require("jsonwebtoken");
const router = express.Router();
const { listServices, createOrder, listMyOrders } = require("../controllers/boostController");

// Same JWT check used in campaignRoutes.js
const verifyToken = (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ success: false, message: "No token provided." });
  }
  try {
    req.user = jwt.verify(authHeader.slice(7), process.env.JWT_SECRET);
    next();
  } catch (err) {
    return res.status(401).json({ success: false, message: "Invalid or expired token." });
  }
};

router.get("/services", verifyToken, listServices);
router.post("/order",   verifyToken, createOrder);
router.get("/orders",   verifyToken, listMyOrders);

module.exports = router;