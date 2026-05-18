const express = require("express");
const router  = express.Router();
const axios   = require("axios");
const admin   = require("firebase-admin");

const PAYSTACK_SECRET = process.env.PAYSTACK_SECRET_KEY;
const db = admin.firestore();

// ── Built-in token verification (no external middleware needed) ────────────
const jwt = require("jsonwebtoken");

// ── Built-in token verification ────────────────────────────────────────────
const verifyToken = (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ success: false, message: "No token provided." });
  }
  const token = authHeader.slice(7);
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded;
    next();
  } catch (err) {
    console.error("JWT verify failed:", err.message);
    return res.status(401).json({ success: false, message: "Invalid or expired token.", detail: err.message });
  }
};

// POST /api/v1/campaigns/submit
router.post("/submit", verifyToken, async (req, res) => {
  try {
    const {
      brandName, taskType, targetCount, slots, pageLink,
      description, mediaNote, contactEmail,
      mediaUrls, mediaCount, quotedTotal, quotedPerUser,
      submittedBy, userDisplayName, userEmail, userUsername,
    } = req.body;

    if (!brandName || !taskType || !slots || !pageLink || !contactEmail) {
      return res.status(400).json({ success: false, message: "Missing required fields." });
    }

    const campaignRef = db.collection("campaigns").doc();
    await campaignRef.set({
      id:              campaignRef.id,
      brandName,
      taskType,
      targetCount:     parseInt(targetCount) || 0,
      slots:           parseInt(slots),
      pageLink,
      description:     description || "",
      mediaNote:       mediaNote || "",
      contactEmail,
      mediaUrls:       mediaUrls || [],
      mediaCount:      mediaCount || 0,
      quotedTotal:     parseFloat(quotedTotal) || 0,
      quotedPerUser:   parseFloat(quotedPerUser) || 0,
      status:          "pending_payment",
      paymentStatus:   "unpaid",
      submittedBy:     submittedBy || req.user?.uid || "",
      userDisplayName: userDisplayName || "Unknown",
      userEmail:       userEmail || req.user?.email || "",
      userUsername:    userUsername || "",
      createdAt:       admin.firestore.FieldValue.serverTimestamp(),
      updatedAt:       admin.firestore.FieldValue.serverTimestamp(),
    });

    return res.json({ success: true, data: { campaignId: campaignRef.id } });
  } catch (err) {
    console.error("Campaign submit error:", err);
    return res.status(500).json({ success: false, message: "Server error." });
  }
});

// POST /api/v1/campaigns/create-payment
router.post("/create-payment", verifyToken, async (req, res) => {
  try {
    const { campaignId, amount, email, userId } = req.body;

    if (!campaignId || !amount || !email) {
      return res.status(400).json({ success: false, message: "campaignId, amount and email are required." });
    }

    const campaignDoc = await db.collection("campaigns").doc(campaignId).get();
    if (!campaignDoc.exists) {
      return res.status(404).json({ success: false, message: "Campaign not found." });
    }

    const campaign = campaignDoc.data();
    if (campaign.paymentStatus === "paid") {
      return res.status(400).json({ success: false, message: "Campaign already paid." });
    }

    const NGN_RATE    = 1500;
    const amountNGN  = Math.round(parseFloat(amount) * NGN_RATE) + 200; // hidden ₦200 service charge
    const amountKobo  = amountNGN * 100;   // ✅ 
    const reference   = `pe_campaign_${campaignId}_${Date.now()}`;
    const callbackUrl = process.env.PAYSTACK_CALLBACK_URL || "https://promoearn-backend.onrender.com/payment-success";

    const paystackRes = await axios.post(
      "https://api.paystack.co/transaction/initialize",
      {
        email,
        amount:   amountKobo,
        reference,
        currency: "NGN",
        channels: ["card", "bank", "ussd", "bank_transfer", "qr"],
        metadata: {
          campaignId,
          userId:        userId || "",
          type:          "campaign_payment",
          amount_usd:    `$${parseFloat(amount).toFixed(2)}`,
          amount_ngn:    `₦${amountNGN.toLocaleString()}`,
        },
        callback_url: callbackUrl,
      },
      {
        headers: {
          Authorization:  `Bearer ${PAYSTACK_SECRET}`,
          "Content-Type": "application/json",
        },
      }
    );

    if (!paystackRes.data?.data?.authorization_url) {
      return res.status(500).json({ success: false, message: "Failed to create Paystack session." });
    }

    await db.collection("campaigns").doc(campaignId).update({
      paymentRef:    reference,
      paymentStatus: "initiated",
      updatedAt:     admin.firestore.FieldValue.serverTimestamp(),
    });

    return res.json({
      success: true,
      data: {
        url:       paystackRes.data.data.authorization_url,
        reference: paystackRes.data.data.reference,
      },
    });
  } catch (err) {
    console.error("Campaign create-payment error:", err.response?.data || err.message);
    return res.status(500).json({ success: false, message: "Payment initialisation failed." });
  }
});

// POST /api/v1/campaigns/verify-payment
router.post("/verify-payment", verifyToken, async (req, res) => {
  try {
    const { reference, campaignId } = req.body;

    if (!reference || !campaignId) {
      return res.status(400).json({ success: false, message: "reference and campaignId are required." });
    }

    const verifyRes = await axios.get(
      `https://api.paystack.co/transaction/verify/${reference}`,
      { headers: { Authorization: `Bearer ${PAYSTACK_SECRET}` } }
    );

    const txData = verifyRes.data?.data;
    if (!txData || txData.status !== "success") {
      return res.status(400).json({ success: false, message: "Payment not confirmed. Please try again." });
    }

    const campaignDoc = await db.collection("campaigns").doc(campaignId).get();
    if (!campaignDoc.exists) {
      return res.status(404).json({ success: false, message: "Campaign not found." });
    }

    const campaign = campaignDoc.data();
    if (campaign.paymentStatus === "paid" || campaign.status === "paid") {
      return res.json({ success: true, message: "Campaign already activated." });
    }

    await db.collection("campaigns").doc(campaignId).update({
      status:        "paid",
      paymentStatus: "paid",
      paymentRef:    reference,
      paidAt:        admin.firestore.FieldValue.serverTimestamp(),
      updatedAt:     admin.firestore.FieldValue.serverTimestamp(),
    });
// Credit ₦100 advertising bonus to the campaign owner
const AD_BONUS = 100 / 1500; // ₦100 = ~$0.067

const campaignOwnerUid = campaign.submittedBy;
if (campaignOwnerUid) {
  // Credit balance
  await db.collection("users").doc(campaignOwnerUid).update({
    balance: admin.firestore.FieldValue.increment(AD_BONUS),
  });

  // Create notification
  await db.collection("notifications").add({
    userId:    campaignOwnerUid,
    title:     "Ad Bonus Credited! 🎉",
    message:   `₦100 ($${AD_BONUS.toFixed(3)}) has been credited to your PromoEarn wallet as an advertising bonus for your campaign.`,
    type:      "bonus",
    read:      false,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });
}
    return res.json({ success: true, message: "Payment confirmed. Campaign is now under review." });
  } catch (err) {
    console.error("Campaign verify-payment error:", err.response?.data || err.message);
    return res.status(500).json({ success: false, message: "Verification failed." });
  }
});

// GET /api/v1/admin/campaigns
router.get(["/campaigns", "/"], verifyToken, async (req, res) => {
  try {
    const snapshot = await db.collection("campaigns").get();
    const campaigns = snapshot.docs
      .map(doc => ({ id: doc.id, ...doc.data() }))
      .sort((a, b) => (b.createdAt?._seconds ?? 0) - (a.createdAt?._seconds ?? 0));
    return res.json({ success: true, data: { campaigns } });
  } catch (err) {
    console.error("Admin campaigns error:", err);
    return res.status(500).json({ success: false, message: "Server error." });
  }
});

// PATCH /api/v1/admin/campaigns/:id/status
router.patch(["/:id/status", "/campaigns/:id/status"], verifyToken, async (req, res) => {
  try {
    const { id }                = req.params;
    const { status, adminNote } = req.body;

    const validStatuses = ["approved", "rejected", "live", "completed"];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ success: false, message: `Invalid status. Must be one of: ${validStatuses.join(", ")}` });
    }

    const update = { status, updatedAt: admin.firestore.FieldValue.serverTimestamp() };
    if (adminNote !== undefined) update.adminNote  = adminNote;
    if (status === "live")       update.liveAt      = admin.firestore.FieldValue.serverTimestamp();
    if (status === "completed")  update.completedAt = admin.firestore.FieldValue.serverTimestamp();

    await db.collection("campaigns").doc(id).update(update);
    return res.json({ success: true, message: `Campaign ${status}.` });
  } catch (err) {
    console.error("Admin campaign status error:", err);
    return res.status(500).json({ success: false, message: "Server error." });
  }
});

// POST /api/v1/campaigns/webhook  ← Paystack calls this automatically after payment
router.post("/webhook", express.raw({ type: "application/json" }), async (req, res) => {
  const crypto = require("crypto");

  // ── 1. Verify the request is genuinely from Paystack ──────────────────
  const signature = req.headers["x-paystack-signature"];
  const hash = crypto
    .createHmac("sha512", process.env.PAYSTACK_SECRET_KEY)
    .update(req.body)
    .digest("hex");

  if (hash !== signature) {
    console.warn("Webhook: invalid signature — rejected");
    return res.status(400).json({ success: false, message: "Invalid signature." });
  }

  // ── 2. Parse the event ────────────────────────────────────────────────
  let event;
  try {
    event = JSON.parse(req.body.toString());
  } catch {
    return res.status(400).json({ success: false, message: "Invalid JSON." });
  }

  // ── 3. Only handle successful campaign payments ───────────────────────
  if (event.event !== "charge.success") {
    return res.sendStatus(200); // Acknowledge other events but do nothing
  }

  const meta = event.data?.metadata || {};
  if (meta.type !== "campaign_payment" || !meta.campaignId) {
    return res.sendStatus(200); // Not a campaign payment — ignore
  }

  const { campaignId } = meta;
  const reference      = event.data.reference;

  try {
    const campaignDoc = await db.collection("campaigns").doc(campaignId).get();

    if (!campaignDoc.exists) {
      console.error(`Webhook: campaign ${campaignId} not found`);
      return res.sendStatus(200);
    }

    const campaign = campaignDoc.data();

    // Avoid double-processing
    if (campaign.paymentStatus === "paid") {
      return res.sendStatus(200);
    }

    // ── 4. Mark campaign as paid ────────────────────────────────────────
    await db.collection("campaigns").doc(campaignId).update({
      status:        "paid",
      paymentStatus: "paid",
      paymentRef:    reference,
      paidAt:        admin.firestore.FieldValue.serverTimestamp(),
      updatedAt:     admin.firestore.FieldValue.serverTimestamp(),
    });

    console.log(`Webhook: campaign ${campaignId} marked as paid via ${reference}`);
  } catch (err) {
    console.error("Webhook: Firestore update failed:", err.message);
    // Still return 200 so Paystack doesn't keep retrying
  }

  return res.sendStatus(200);
});

// GET /api/v1/campaigns/my
router.get("/my", verifyToken, async (req, res) => {
  try {
    const userId = req.user.uid;
    if (!userId) {
      return res.status(401).json({ success: false, message: "Cannot identify user from token." });
    }
    const snapshot = await db.collection("campaigns")
    .where("submittedBy", "==", userId)
    .get();
  
  const campaigns = snapshot.docs
    .map(doc => ({ id: doc.id, ...doc.data() }))
    .sort((a, b) => {
      const aTime = a.createdAt?._seconds ?? 0;
      const bTime = b.createdAt?._seconds ?? 0;
      return bTime - aTime;
    });
    return res.json({ success: true, data: { campaigns } });  // ADD THIS LINE
  } catch (err) {


    console.error("My campaigns error:", err);
    return res.status(500).json({ success: false, message: "Server error." });
  }
});

module.exports = router;