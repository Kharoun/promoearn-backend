const express = require("express");
const router  = express.Router();
// const axios   = require("axios");
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
    if (parseInt(slots) < 100) {
      return res.status(400).json({ success: false, message: "Minimum number of slots is 100." });
    }
    if (targetCount && parseInt(targetCount) < 100) {
      return res.status(400).json({ success: false, message: "Minimum target count is 100." });
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

// POST /api/v1/campaigns/manual-payment
router.post("/manual-payment", verifyToken, async (req, res) => {
  try {
    const { campaignId, senderName, amountNGN } = req.body;

    if (!campaignId || !senderName?.trim()) {
      return res.status(400).json({ success: false, message: "campaignId and senderName are required." });
    }

    const campaignDoc = await db.collection("campaigns").doc(campaignId).get();
    if (!campaignDoc.exists) {
      return res.status(404).json({ success: false, message: "Campaign not found." });
    }

    const campaign = campaignDoc.data();
    if (campaign.paymentStatus === "paid") {
      return res.json({ success: true, message: "Campaign already paid." });
    }

    await db.collection("campaigns").doc(campaignId).update({
      status:        "pending_payment_review",
      paymentStatus: "pending_manual",
      senderName:    senderName.trim(),
      amountNGN:     amountNGN || 0,
      updatedAt:     admin.firestore.FieldValue.serverTimestamp(),
    });

    return res.json({ success: true, message: "Payment submission received. Your campaign will be reviewed within 1–6 hours." });
  } catch (err) {
    console.error("Campaign manual-payment error:", err);
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
    return res.json({ success: true, data: { campaigns } });  // ADD THIS LINE
  } catch (err) {


    console.error("My campaigns error:", err);
    return res.status(500).json({ success: false, message: "Server error." });
  }
});

module.exports = router;