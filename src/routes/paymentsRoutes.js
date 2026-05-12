const express    = require("express");
const router     = express.Router();
const { protect } = require("../middleware/authMiddleware");
const {
  createCheckout,
  verifyPayment,
  paystackWebhook,
  requestWithdrawal,
  getTransactions,
  getBanks,        // ← add
  verifyAccount,   // ← add
} = require("../controllers/paymentsController"); 

router.get("/banks",          protect, getBanks);
router.post("/verify-account", protect, verifyAccount);

// ── Webhook must be BEFORE express.json() middleware ──
// Raw body is needed for signature verification
router.post("/webhook", express.raw({ type:"application/json" }), paystackWebhook);

// Protected routes
router.post("/create-checkout",  protect, createCheckout);
router.post("/verify-payment",   protect, verifyPayment);
router.get("/transactions",      protect, getTransactions);
router.post("/withdraw",         protect, requestWithdrawal);

module.exports = router;

