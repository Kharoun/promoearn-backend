const express = require("express");
const { Resend } = require('resend');
const resend = new Resend(process.env.RESEND_API_KEY);
const router  = express.Router();
const admin   = require("firebase-admin");

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
const MIN_VERSION = "1.4.0";

const compareVersions = (current, required) => {
  if (!current) return -1;
  const curr = current.split(".").map(Number);
  const req  = required.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if ((curr[i] || 0) > (req[i] || 0)) return 1;
    if ((curr[i] || 0) < (req[i] || 0)) return -1;
  }
  return 0;
};

const requireMinVersion = (req, res) => {
  const appVersion = req.headers["x-app-version"];
  if (compareVersions(appVersion, MIN_VERSION) < 0) {
    res.status(426).json({
      success:         false,
      updateRequired:  true,
      message:         "Please update your app to the latest version to submit a campaign.",
      requiredVersion: MIN_VERSION,
      currentVersion:  appVersion || "unknown",
    });
    return false;
  }
  return true;
};

// POST /api/v1/campaigns/submit
router.post("/submit", verifyToken, async (req, res) => {
  try {
    // ✅ Version gate — blocks outdated app versions
    if (!requireMinVersion(req, res)) return;

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

    resend.emails.send({
      from:    'PromoEarn <noreply@promoearnapp.com>',
      to:      'contact.promoearn@gmail.com',
      subject: '💳 New Campaign Payment Transfer — PromoEarn Admin',
      html: `
        <div style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:20px">
          <div style="background:#7C3AED;padding:20px;border-radius:12px 12px 0 0;text-align:center">
            <h2 style="color:#fff;margin:0">PromoEarn Admin</h2>
          </div>
          <div style="background:#fff;padding:28px;border:1px solid #E2E8F0;border-top:none;border-radius:0 0 12px 12px">
            <p style="font-size:15px;color:#0F172A">A user has submitted a <strong>campaign bank transfer</strong>.</p>
            <div style="background:#F5F3FF;border-radius:10px;padding:16px;margin:16px 0;font-size:14px;color:#0F172A;line-height:1.9;">
              <p style="margin:0 0 4px;font-weight:700;">Campaign Details:</p>
              <p style="margin:0;"><strong>Brand:</strong> ${campaign.brandName}</p>
              <p style="margin:0;"><strong>Campaign ID:</strong> ${campaignId}</p>
              <p style="margin:0;"><strong>Sender Name:</strong> ${senderName.trim()}</p>
              <p style="margin:0;"><strong>Amount:</strong> ₦${(amountNGN || 0).toLocaleString()}</p>
              <p style="margin:0;"><strong>Quoted Total:</strong> $${campaign.quotedTotal || 0}</p>
              <p style="margin:0;"><strong>Submitted:</strong> ${new Date().toLocaleString('en-NG', { timeZone: 'Africa/Lagos' })} (WAT)</p>
            </div>
            <div style="text-align:center;margin:24px 0;">
              <a href="https://promo-earn-admin.vercel.app"
                 style="display:inline-block;background:#7C3AED;color:#fff;padding:14px 32px;border-radius:10px;text-decoration:none;font-weight:700;font-size:15px;">
                👉 Review in Admin Panel
              </a>
            </div>
          </div>
        </div>
      `,
    }).catch(err => console.error('Admin campaign payment email failed:', err));

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
    return res.json({ success: true, data: { campaigns } });
  } catch (err) {
    console.error("My campaigns error:", err);
    return res.status(500).json({ success: false, message: "Server error." });
  }
});

module.exports = router;