const express    = require("express");
const router     = express.Router();
const { protect } = require("../middleware/authMiddleware");
const {
  createCheckout,
  verifyPayment,
  paystackWebhook,
  requestWithdrawal,
  getTransactions,
  getBanks,
  verifyAccount,
  validateReactivationToken,   // ← add
  createReactivationCheckout,  // ← add
  verifyReactivation,          // ← add
} = require('../controllers/paymentsController');

// ── Public routes (no auth — user is banned so they have no token) ──
router.get('/reactivate/validate',   validateReactivationToken);
router.post('/reactivate/checkout',  createReactivationCheckout);
router.post('/reactivate/verify',    verifyReactivation);

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

