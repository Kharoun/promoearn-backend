const { getDb } = require("../config/firebase");
const admin = require("firebase-admin");

// ─── PUBLIC: Get active rates ──────────────────────────────────────────────
exports.getRates = async (req, res) => {
  try {
    const db = getDb();
    const snap = await db.collection("giftCardRates").where("active", "==", true).get();
    const rates = snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    return res.json({ success: true, data: { rates } });
  } catch (err) {
    console.error("Get rates error:", err);
    return res.status(500).json({ success: false, message: "Failed to fetch rates." });
  }
};

// ─── USER: Submit a gift card ──────────────────────────────────────────────
exports.submitGiftCard = async (req, res) => {
  try {
    const db  = getDb();
    const uid = req.user.uid;
    const { brand, cardType, faceValue, code, pin, country } = req.body;

    if (!brand || !cardType || !faceValue || !country) {
      return res.status(400).json({ success: false, message: "Missing required fields." });
    }
    if (!code) {
      return res.status(400).json({ success: false, message: "Card code is required." });
    }
    if (cardType === "physical" && (!req.files?.front || !req.files?.back)) {
      return res.status(400).json({ success: false, message: "Front and back photos are required for physical cards." });
    }

    // Look up the active rate for this brand + type
    const rateSnap = await db.collection("giftCardRates")
      .where("brand", "==", brand)
      .where("cardType", "==", cardType)
      .where("active", "==", true)
      .limit(1).get();

    if (rateSnap.empty) {
      return res.status(400).json({ success: false, message: "This brand/card type is not currently accepted." });
    }
    const rate = rateSnap.docs[0].data();
    const face = parseFloat(faceValue);
    const quotedAmount = +(face * (rate.ratePercent / 100)).toFixed(2);

    // Upload photos for physical cards
    let frontUrl = null, backUrl = null;
    if (cardType === "physical") {
      const bucket = admin.storage().bucket();
      const uploadOne = async (file, label) => {
        const filename = `giftcard-proofs/${uid}_${Date.now()}_${label}.jpg`;
        const fileRef = bucket.file(filename);
        await fileRef.save(file.buffer, { metadata: { contentType: file.mimetype || "image/jpeg" }, public: true });
        return `https://storage.googleapis.com/${bucket.name}/${filename}`;
      };
      frontUrl = await uploadOne(req.files.front[0], "front");
      backUrl  = await uploadOne(req.files.back[0], "back");
    }

    if (cardType === "physical" && (!req.files?.front || !req.files?.back)) {
      console.log("🔍 Gift card upload debug:", {
        hasFiles: !!req.files,
        fileKeys: req.files ? Object.keys(req.files) : [],
        frontCount: req.files?.front?.length || 0,
        backCount: req.files?.back?.length || 0,
        bodyKeys: Object.keys(req.body || {}),
      });
      return res.status(400).json({ success: false, message: "Front and back photos are required for physical cards." });
    }
    
    const userDoc = await db.collection("users").doc(uid).get();
    const user = userDoc.exists ? userDoc.data() : {};

    const subRef = await db.collection("giftCardSubmissions").add({
      userId: uid,
      username: user.username || "",
      email: user.email || "",
      brand,
      cardType,          // "ecode" | "physical"
      country,
      faceValue: face,
      ratePercent: rate.ratePercent,
      quotedAmount,
      code: code || null,   // stored for BOTH card types now
      pin: pin || null,     // stored for BOTH card types now
      frontUrl,
      backUrl,
      status: "pending",
      submittedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    await db.collection("adminNotifications").add({
      type: "giftcard_submission",
      submissionId: subRef.id,
      userId: uid,
      message: `New ${brand} ${cardType} gift card submitted ($${face} face value) by ${user.username || uid} · ${country}`,
      read: false,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    // Notify the user their submission was received
    await db.collection("notifications").add({
      userId: uid,
      title: "🎁 Gift Card Submitted",
      body: `Your ${brand} gift card ($${face.toFixed(2)} face value) was submitted for review. We'll notify you once it's verified.`,
      type: "paymentAlerts",
      read: false,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    return res.json({
      success: true,
      message: "Gift card submitted for review. You'll be credited once it's verified.",
      data: { submissionId: subRef.id, quotedAmount },
    });
  } catch (err) {
    console.error("submitGiftCard error:", err);
    return res.status(500).json({ success: false, message: "Server error." });
  }
};

// ─── USER: My gift card submissions ────────────────────────────────────────
exports.getMyGiftCardSubmissions = async (req, res) => {
  try {
    const db  = getDb();
    const uid = req.user.uid;
    const snap = await db.collection("giftCardSubmissions").where("userId", "==", uid).get();
    const submissions = snap.docs
      .map(doc => {
        const d = doc.data();
        // never return code/pin back to the client after submission
        const { code, pin, ...safe } = d;
        return { id: doc.id, ...safe };
      })
      .sort((a, b) => (b.submittedAt?._seconds || 0) - (a.submittedAt?._seconds || 0));
    return res.json({ success: true, data: { submissions } });
  } catch (err) {
    console.error("getMyGiftCardSubmissions error:", err);
    return res.status(500).json({ success: false, message: "Server error." });
  }
};