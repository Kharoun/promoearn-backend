const { getDb }   = require("../config/firebase");
const express     = require("express");
const router      = express.Router();
const { protect } = require("../middleware/authMiddleware");

const isAdmin = (req, res, next) => {
  if (!req.user || !req.user.isAdmin) {
    return res.status(403).json({ success: false, message: "Admin access required." });
  }
  next();
};

const {
  createCheckout,
  verifyPayment,
  paystackWebhook,
  requestWithdrawal,
  getTransactions,
  getBanks,
  verifyAccount,
  validateReactivationToken,
  createReactivationCheckout,
  verifyReactivation,
  manualActivation,
  requestReactivation,
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
router.post('/request-reactivation', requestReactivation);
router.get("/transactions",      protect, getTransactions);
router.post("/withdraw",         protect, requestWithdrawal);
router.post("/manual-activation", protect, manualActivation);
// GET /api/v1/admin/pending-activations
router.get("/pending-activations", protect, isAdmin, async (req, res) => {
  try {
    const db   = getDb();
    const filter = req.query.status || "pending"; // pending | approved | rejected | all
    let query = db.collection("pendingActivations");
    if (filter !== "all") query = query.where("status", "==", filter);
    const snap = await query.orderBy("createdAt", "desc").get();
    const items = snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    return res.json({ success: true, data: { items } });
  } catch (err) {
    console.error("pending-activations list error:", err);
    return res.status(500).json({ success: false, message: "Server error." });
  }
});

// POST /api/v1/admin/approve-activation
router.post("/approve-activation", protect, isAdmin, async (req, res) => {
  try {
    const { activationId, userId, action, rejectReason } = req.body;
    // action = "approve" | "reject"
    const db = getDb();

    if (action === "approve") {
      const userDoc = await db.collection("users").doc(userId).get();
      if (!userDoc.exists) return res.status(404).json({ success: false, message: "User not found." });
      const user = userDoc.data();

      if (!user.isActivated) {
        const WELCOME_BONUS  = 0;
        const REFERRAL_BONUS = 1.33;

        await db.collection("users").doc(userId).update({
          isActivated: true,
          balance:     (user.balance     || 0) + WELCOME_BONUS,
          totalEarned: (user.totalEarned || 0) + WELCOME_BONUS,
          updatedAt:   new Date(),
        });

        await db.collection("transactions").add({
          userId, type: "registration", description: "Manual bank transfer activation",
          amount: -3.00, status: "completed", createdAt: new Date(),
        });

        // Referral bonus
        if (user.referredBy) {
          const refDoc = await db.collection("users").doc(user.referredBy).get();
          if (refDoc.exists) {
            const ref = refDoc.data();
            await db.collection("users").doc(user.referredBy).update({
              balance:        (ref.balance        || 0) + REFERRAL_BONUS,
              totalEarned:    (ref.totalEarned    || 0) + REFERRAL_BONUS,
              referralsCount: (ref.referralsCount || 0) + 1,
              updatedAt:      new Date(),
            });
            await db.collection("transactions").add({
              userId: user.referredBy, type: "referral",
              description: `Referral bonus from @${user.username}`,
              amount: REFERRAL_BONUS, status: "completed", createdAt: new Date(),
            });
          }
        }

        // Push notification to user
        await db.collection("notifications").add({
          userId, title: "🎉 Account Activated!",
          body: "Your transfer was confirmed. You can now access all tasks and start earning!",
          type: "paymentAlerts", read: false, createdAt: new Date(),
        });
      }

      await db.collection("pendingActivations").doc(activationId).update({
        status: "approved", approvedAt: new Date(),
      });

      return res.json({ success: true, message: "User activated." });

    } else {
      await db.collection("pendingActivations").doc(activationId).update({
        status: "rejected", rejectReason: rejectReason || "Transfer not confirmed",
        rejectedAt: new Date(),
      });

      await db.collection("notifications").add({
        userId, title: "⚠️ Activation Not Confirmed",
        body: rejectReason || "We could not confirm your transfer. Please contact support.",
        type: "paymentAlerts", read: false, createdAt: new Date(),
      });

      return res.json({ success: true, message: "Activation rejected." });
    }
  } catch (err) {
    console.error("approve-activation error:", err);
    return res.status(500).json({ success: false, message: "Server error." });
  }
});

module.exports = router;

