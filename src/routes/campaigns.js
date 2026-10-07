const express = require("express");
const { Resend } = require('resend');
const resend = new Resend(process.env.RESEND_API_KEY);
const router  = express.Router();
const { getDb } = require('../config/firebase');
const admin   = require("firebase-admin");
const { flw } = require("../utils/flutterwave");

const PAYSTACK_SECRET = process.env.PAYSTACK_SECRET_KEY;
const db = admin.firestore();

const { createNotification } = require("../controllers/notificationsController");

const NGN_RATE = 1500;
const PRICE_PER_SLOT = 0.013;
const FEE_PCT = 0.15;
const HIDDEN_FEE = 0.67;
const MIN_SLOTS = 100;
const ALLOWED_TYPES = ["likes","followers","views","signup","comments","shares","downloads","clicks"];
const r2 = (n) => Math.round(n * 100) / 100;

const priceFor = (slots) => {
  const base = r2(PRICE_PER_SLOT * slots * (1 + FEE_PCT)); // goes in quotedTotal
  const total = r2(base + HIDDEN_FEE);                     // what the advertiser pays (USD)
  return { base, total };
};
const fail = (status, message) => Object.assign(new Error(message), { client: true, status });

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

router.post("/submit", verifyToken, async (req, res) => {
  try {
    const gateResult = await checkVersionGate(req, getDb);
    if (gateResult) return res.status(gateResult.status).json(gateResult.body);

    const {
      brandName, taskType, pageLink, description, mediaNote, contactEmail,
      mediaUrls, mediaCount, userDisplayName, userUsername, payWith,
    } = req.body;
    const uid   = req.user.uid;                 // never trust the body for this
    const slots = parseInt(req.body.slots) || 0;

    if (!brandName || !taskType || !pageLink || !contactEmail)
      return res.status(400).json({ success: false, message: "Missing required fields." });
    if (!ALLOWED_TYPES.includes(taskType))
      return res.status(400).json({ success: false, message: "Invalid goal." });
    if (slots < MIN_SLOTS)
      return res.status(400).json({ success: false, message: `Minimum is ${MIN_SLOTS} people.` });

    const { base, total } = priceFor(slots);          // server-side price
    const campaignRef = db.collection("campaigns").doc();
    const tx_ref = `PE-CAMP-${campaignRef.id}-${Date.now()}`;

    const campaignDoc = {
      id: campaignRef.id,
      brandName, taskType, slots,
      targetCount: 0,
      pageLink,
      description: description || "",
      mediaNote: mediaNote || "",
      contactEmail,
      mediaUrls: mediaUrls || [],
      mediaCount: mediaCount || 0,
      quotedTotal: base,
      quotedPerUser: PRICE_PER_SLOT,
      amountUSD: total,
      submittedBy: uid,
      userDisplayName: userDisplayName || "Unknown",
      userEmail: req.user?.email || req.body.userEmail || "",
      userUsername: userUsername || "",
      adType: req.body.adType || "business",
      businessCategory: req.body.businessCategory || "",
      platform: req.body.platform || "",
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    // ───────── PAY FROM BALANCE ─────────
    if (payWith === "balance") {
      const userRef = db.collection("users").doc(uid);
      const txRef   = db.collection("transactions").doc();
      let newBalance = 0;

      await db.runTransaction(async (t) => {
        const snap = await t.get(userRef);               // reads first…
        if (!snap.exists) throw fail(404, "User not found.");
        const u = snap.data();
        if (u.isBanned) throw fail(403, "Account suspended.");
        const bal = u.balance || 0;
        if (bal + 0.000001 < total) throw fail(400, "Insufficient balance.");

        newBalance = r2(bal - total);
        t.update(userRef, { balance: newBalance, updatedAt: new Date() });   // …then writes
        t.set(campaignRef, {
          ...campaignDoc,
          status: "paid",
          paymentStatus: "paid",
          paymentMethod: "balance",
          paymentRef: `BAL-${campaignRef.id}`,
          paidAt: new Date(),
        });
        t.set(txRef, {
          userId: uid, type: "campaign",
          description: `Ad payment: ${brandName}`,
          amount: -total, status: "completed",
          campaignId: campaignRef.id, createdAt: new Date(),
        });
      });

      await createNotification(uid, {
        title: "📢 Ad Submitted",
        body: `$${total.toFixed(2)} was paid from your balance for "${brandName}". It's now in review.`,
        type: "paymentAlerts",
      }).catch(() => {});

      return res.json({
        success: true,
        data: { campaignId: campaignRef.id, paid: true, newBalance },
      });
    }

    // ───────── PAY WITH FLUTTERWAVE ─────────
    const amountNGN = Math.round(total * NGN_RATE) + 200;
    await campaignRef.set({
      ...campaignDoc,
      status: "pending_payment",
      paymentStatus: "unpaid",
      paymentMethod: "flutterwave",
      paymentRef: tx_ref,            // saved BEFORE checkout so settlement can find it
      amountNGN,
    });

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

    return res.json({
      success: true,
      data: { campaignId: campaignRef.id, checkoutUrl: data.data.link, reference: tx_ref },
    });
  } catch (err) {
    if (err.client) return res.status(err.status).json({ success: false, message: err.message });
    console.error("Campaign submit error:", err.response?.data || err.message);
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