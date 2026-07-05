const express = require("express");
const { Resend } = require('resend');
const resend = new Resend(process.env.RESEND_API_KEY);
const router  = express.Router();
const { getDb } = require('../config/firebase');
const admin   = require("firebase-admin");
const { flw } = require("../utils/flutterwave");

const PAYSTACK_SECRET = process.env.PAYSTACK_SECRET_KEY;
const db = admin.firestore();

// ── Built-in token verification ────────────────────────────────────────────
const jwt = require("jsonwebtoken");

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

// ✅ Version check (same logic as userController) ────────────────────────────
const { checkVersionGate } = require("../utils/versionCheck"); // adjust path to wherever versionCheck.js actually lives

// POST /api/v1/campaigns/submit
router.post("/submit", verifyToken, async (req, res) => {
  try {
    const gateResult = await checkVersionGate(req, getDb);
    if (gateResult) return res.status(gateResult.status).json(gateResult.body);

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
      brandName, taskType,
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

    const HIDDEN_FEE = 0.67;
    const NGN_RATE   = 1500;
    const totalUSD   = (parseFloat(quotedTotal) || 0) + HIDDEN_FEE;
    const amountNGN  = Math.round(totalUSD * NGN_RATE) + 200;
    const tx_ref     = `PE-CAMP-${campaignRef.id}-${Date.now()}`;

    const { data } = await flw.post("/payments", {
      tx_ref,
      amount: amountNGN,
      currency: "NGN",
      redirect_url: `${process.env.CLIENT_URL}/payment-success`,
      customer: { email: contactEmail, name: userDisplayName || contactEmail },
      customizations: { title: "PromoEarn Campaign", description: `Campaign: ${brandName}` },
      meta: { campaignId: campaignRef.id, purpose: "campaign", tx_ref },
    });

    if (data.status !== "success") {
      console.error("Flutterwave campaign init error:", data);
      return res.status(400).json({ success: false, message: data.message || "Failed to start payment." });
    }

    await campaignRef.update({ paymentRef: tx_ref, amountNGN });

    return res.json({
      success: true,
      data: { campaignId: campaignRef.id, checkoutUrl: data.data.link, reference: tx_ref },
    });
  } catch (err) {
    console.error("Campaign submit error:", err.response?.data || err.message);
    return res.status(500).json({ success: false, message: "Server error." });
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
    return res.json({ success: true, data: { campaigns } });
  } catch (err) {
    console.error("My campaigns error:", err);
    return res.status(500).json({ success: false, message: "Server error." });
  }
});

module.exports = router;