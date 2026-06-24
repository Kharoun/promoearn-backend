require("dotenv").config();
const express = require("express");
const helmet = require("helmet");
const cors = require("cors");
const morgan = require("morgan");

const { initFirebase } = require("./config/firebase");
const authRoutes = require("./routes/authRoutes");


// ─── Initialize Firebase ──────────────────────────────────────────────────────
initFirebase();
require('./jobs/inactivityJob'); 
// ─── App Setup ────────────────────────────────────────────────────────────────
const app = express();

app.set('trust proxy', 1);

// Security headers
// CORS — must be before helmet
const allowedOrigins = process.env.CORS_ORIGINS
  ? process.env.CORS_ORIGINS.split(",").map(o => o.trim())
  : [
      "http://localhost:5173",
      "http://localhost:8081",
      "https://promoearnapp.com",
      "https://app.promoearnapp.com",
    ];

app.use(
  cors({
    origin: (origin, callback) => {
      // Allow no-origin requests (mobile apps, Postman, curl)
      if (!origin) return callback(null, true);
      // Allow Vercel preview URLs
      if (/^https:\/\/.*promo-earn.*\.vercel\.app$/.test(origin)) return callback(null, true);
      // Allow matched origins
      if (allowedOrigins.includes(origin)) return callback(null, true);
      // Log what's being blocked to help debug
      console.warn("CORS blocked origin:", origin);
      return callback(null, false); // ← return false instead of throwing an Error
    },
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "x-app-version"],
    credentials: true,
  })
);

// Handle preflight for all routes
app.options("*", cors());

  app.use(
    cors({
      origin: (origin, callback) => {
        // Allow requests with no origin (mobile apps, curl, Postman)
        if (!origin) return callback(null, true);
        // Allow all Vercel preview URLs for your project
        if (/^https:\/\/.*promo-earn.*\.vercel\.app$/.test(origin)) return callback(null, true);
        if (allowedOrigins.includes(origin)) return callback(null, true);
        return callback(new Error("Not allowed by CORS"));
      },
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
app.use("/api/v1/campaigns/webhook", express.raw({ type: "application/json" })); // ← add this

// Body parsing
app.use(express.json({ limit: "5mb" }));
app.use(express.urlencoded({ limit: "5mb", extended: true }));

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
// ─── Routes ───────────────────────────────────────────────────────────────────
const adminRoutes         = require("./routes/adminRoutes");
const paymentsRoutes      = require("./routes/paymentsRoutes");
const userRoutes          = require("./routes/userRoutes");
const notificationsRoutes = require("./routes/notificationsRoutes");
const campaignsRoutes     = require("./routes/campaigns");
const taskProofRoutes     = require("./routes/taskProofRoutes");

app.use("/api/v1/auth",         authRoutes);
app.use("/api/v1/admin",        adminRoutes);
app.use("/api/v1/payments",     paymentsRoutes);
app.use("/api/v1/notifications", notificationsRoutes);
app.use("/api/v1/campaigns",    campaignsRoutes);
app.use("/api/v1/admin",        campaignsRoutes);  // ← add this line
// app.use("/api/v1",              userRoutes);
// app.use("/api/v1/admin",        campaignsRoutes);
app.use("/api/v1/tasks",        taskProofRoutes);
app.use("/api/v1",              userRoutes);   // ← must be LAST (it's a catch-all)

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

//self ping

// Keep Render alive — ping self every 14 minutes
if (process.env.NODE_ENV === "production") {
  setInterval(() => {
    fetch("https://promoearn-backend.onrender.com/health")
      .then(() => console.log("Keep-alive ping sent"))
      .catch(() => {});
  }, 14 * 60 * 1000);
}

// ─── Start Server ─────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`\n🚀 PromoEarn Auth API running on port ${PORT}`);
  console.log(`📖 Environment: ${process.env.NODE_ENV || "development"}`);
  console.log(`🌐 Health check: http://localhost:${PORT}/health\n`);
});

module.exports = app;
