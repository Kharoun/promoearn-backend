process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
require("dotenv").config();
const express = require("express");
const helmet = require("helmet");
const cors = require("cors");
const morgan = require("morgan");

const { initFirebase } = require("./config/firebase");
const authRoutes = require("./routes/authRoutes");

// ─── Initialize Firebase ──────────────────────────────────────────────────────
initFirebase();

// ─── App Setup ────────────────────────────────────────────────────────────────
const app = express();

// Security headers
// CORS — must be before helmet
app.use(
  cors({
    origin: [
      "http://localhost:5173",
      "http://127.0.0.1:5173",
      "http://localhost:8081",
      "http://127.0.0.1:8081",
    ],
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    credentials: true,
  })
);

// Security headers
app.use(helmet({
  crossOriginResourcePolicy: false,
}));

// Request logging
if (process.env.NODE_ENV !== "test") {
  app.use(morgan(process.env.NODE_ENV === "production" ? "combined" : "dev"));
}
// Raw body for Paystack webhook signature verification
app.use("/api/v1/payments/webhook", express.raw({ type: "application/json" }));

// Body parsing
app.use(express.json({ limit: "10kb" }));
app.use(express.urlencoded({ extended: true }));

// ─── Health Check ─────────────────────────────────────────────────────────────
app.get("/health", (req, res) => {
  res.status(200).json({
    success: true,
    message: "PromoEarn Auth API is running 🚀",
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV,
  });
});

// ─── Routes ───────────────────────────────────────────────────────────────────
const adminRoutes    = require("./routes/adminRoutes");
const paymentsRoutes = require("./routes/paymentsRoutes");
const userRoutes     = require("./routes/userRoutes");

app.use("/api/v1/auth",     authRoutes);
app.use("/api/v1/admin",    adminRoutes);
app.use("/api/v1/payments", paymentsRoutes);
const notificationsRoutes = require("./routes/notificationsRoutes");
app.use("/api/v1",               userRoutes);
app.use("/api/v1/notifications", notificationsRoutes);
// ─── 404 Handler ──────────────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: `Route ${req.method} ${req.originalUrl} not found.`,
  });
});

// ─── Global Error Handler ─────────────────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error("Unhandled error:", err);
  res.status(err.status || 500).json({
    success: false,
    message:
      process.env.NODE_ENV === "production"
        ? "Something went wrong. Please try again."
        : err.message,
  });
});

// ─── Start Server ─────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`\n🚀 PromoEarn Auth API running on port ${PORT}`);
  console.log(`📖 Environment: ${process.env.NODE_ENV || "development"}`);
  console.log(`🌐 Health check: http://localhost:${PORT}/health\n`);
});

module.exports = app;
