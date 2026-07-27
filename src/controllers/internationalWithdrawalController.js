const { getDb } = require("../config/firebase");
const admin = require("firebase-admin");

const NGN_RATE = 1500;

const getConfig = async (db) => {
  const doc = await db.collection("intlWithdrawalConfig").doc("settings").get();
  if (!doc.exists) {
    return { nonCryptoFeeNgn: 500, cryptoGasFeeNgn: 0, cryptoExtraFeeNgn: 200, minWithdrawUsd: 3.5, active: true };
  }
  return doc.data();
};

exports.getPublicConfig = async (req, res) => {
  try {
    const db = getDb();
    const cfg = await getConfig(db);
    const nonCryptoFeeUsd = +(cfg.nonCryptoFeeNgn / NGN_RATE).toFixed(2);
    const cryptoFeeUsd = +(((cfg.cryptoGasFeeNgn || 0) + cfg.cryptoExtraFeeNgn) / NGN_RATE).toFixed(2);
    return res.json({
      success: true,
      data: {
        minWithdrawUsd: cfg.minWithdrawUsd,
        active: cfg.active,
        fees: { paypal: nonCryptoFeeUsd, bank: nonCryptoFeeUsd, payoneer: nonCryptoFeeUsd, crypto: cryptoFeeUsd },
      },
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: "Failed to load config." });
  }
};

exports.getConfigAdmin = async (req, res) => {
  try {
    const db = getDb();
    const cfg = await getConfig(db);
    return res.json({ success: true, data: { config: cfg } });
  } catch (err) {
    return res.status(500).json({ success: false, message: "Failed to load config." });
  }
};

exports.updateConfig = async (req, res) => {
  try {
    const db = getDb();
    const { nonCryptoFeeNgn, cryptoGasFeeNgn, cryptoExtraFeeNgn, minWithdrawUsd, active } = req.body;
    const data = {
      nonCryptoFeeNgn: parseFloat(nonCryptoFeeNgn),
      cryptoGasFeeNgn: parseFloat(cryptoGasFeeNgn) || 0,
      cryptoExtraFeeNgn: parseFloat(cryptoExtraFeeNgn),
      minWithdrawUsd: parseFloat(minWithdrawUsd),
      active: active !== false,
      updatedAt: new Date(),
    };
    await db.collection("intlWithdrawalConfig").doc("settings").set(data, { merge: true });
    return res.json({ success: true, message: "Config saved." });
  } catch (err) {
    return res.status(500).json({ success: false, message: "Failed to save config." });
  }
};

exports.submitWithdrawal = async (req, res) => {
  const db = getDb();
  const uid = req.user.uid;
  const { method, amount, details } = req.body; // method: "paypal" | "bank" | "crypto" | "payoneer"

  if (!method || !amount || !details) {
    return res.status(400).json({ success: false, message: "Missing required fields." });
  }

  try {
    const cfg = await getConfig(db);
    if (!cfg.active) {
      return res.status(400).json({ success: false, message: "International withdrawals are temporarily unavailable." });
    }

    const amt = parseFloat(amount);
    if (!amt || amt < cfg.minWithdrawUsd) {
      return res.status(400).json({ success: false, message: `Minimum withdrawal is $${cfg.minWithdrawUsd.toFixed(2)}.` });
    }

    const feeNgn = method === "crypto" ? (cfg.cryptoGasFeeNgn || 0) + cfg.cryptoExtraFeeNgn : cfg.nonCryptoFeeNgn;
    const feeUsd = +(feeNgn / NGN_RATE).toFixed(2);
    const youReceive = +(amt - feeUsd).toFixed(2);

    if (youReceive <= 0) {
      return res.status(400).json({ success: false, message: "Amount too small after fees." });
    }

    const userRef = db.collection("users").doc(uid);
    const userDoc = await userRef.get();
    if (!userDoc.exists) return res.status(404).json({ success: false, message: "User not found." });
    const user = userDoc.data();

    if ((user.balance || 0) < amt) {
      return res.status(400).json({ success: false, message: "Insufficient balance." });
    }

    await userRef.update({ balance: admin.firestore.FieldValue.increment(-amt), updatedAt: new Date() });

    const withdrawalRef = await db.collection("intlWithdrawals").add({
      userId: uid,
      username: user.username || "",
      email: user.email || "",
      method,
      details,
      amount: amt,
      feeNgn,
      feeUsd,
      youReceive,
      status: "pending",
      createdAt: new Date(),
    });

    await db.collection("transactions").add({
      userId: uid,
      type: "withdrawal",
      description: `International withdrawal (${method})`,
      amount: -amt,
      status: "pending",
      createdAt: new Date(),
    });

    return res.json({
      success: true,
      message: "Withdrawal request submitted. It will be processed within 24-48 hours.",
      data: { withdrawalId: withdrawalRef.id, youReceive, feeUsd },
    });
  } catch (err) {
    console.error("submitWithdrawal error:", err);
    return res.status(500).json({ success: false, message: "Server error." });
  }
};

exports.getWithdrawalsAdmin = async (req, res) => {
  try {
    const db = getDb();
    const status = req.query.status || "all";
    let query = db.collection("intlWithdrawals");
    if (status !== "all") query = query.where("status", "==", status);
    const snap = await query.get();
    const withdrawals = snap.docs
      .map(doc => ({ id: doc.id, ...doc.data() }))
      .sort((a, b) => (b.createdAt?._seconds || 0) - (a.createdAt?._seconds || 0));
    return res.json({ success: true, data: { withdrawals } });
  } catch (err) {
    return res.status(500).json({ success: false, message: "Server error." });
  }
};

exports.processWithdrawalAdmin = async (req, res) => {
  try {
    const { id } = req.params;
    const { action } = req.body;
    const db = getDb();

    const docRef = db.collection("intlWithdrawals").doc(id);
    const doc = await docRef.get();
    if (!doc.exists) return res.status(404).json({ success: false, message: "Withdrawal not found." });
    const w = doc.data();
    if (w.status !== "pending") return res.status(400).json({ success: false, message: "Already processed." });

    if (action === "approve") {
      await docRef.update({ status: "approved", approvedAt: new Date() });
      await db.collection("notifications").add({
        userId: w.userId,
        title: "💸 Withdrawal Sent!",
        body: `Your international withdrawal of $${w.youReceive.toFixed(2)} via ${w.method} has been sent.`,
        type: "paymentAlerts", read: false, createdAt: new Date(),
      });
      return res.json({ success: true, message: "Marked as approved. User notified." });
    } else if (action === "reject") {
      const userRef = db.collection("users").doc(w.userId);
      const userDoc = await userRef.get();
      if (userDoc.exists) {
        await userRef.update({ balance: admin.firestore.FieldValue.increment(w.amount), updatedAt: new Date() });
      }
      await docRef.update({ status: "rejected", rejectedAt: new Date() });
      await db.collection("notifications").add({
        userId: w.userId,
        title: "⚠️ Withdrawal Not Processed",
        body: `Your international withdrawal of $${w.amount.toFixed(2)} could not be processed. Your balance has been refunded.`,
        type: "paymentAlerts", read: false, createdAt: new Date(),
      });
      return res.json({ success: true, message: "Rejected and refunded." });
    }
    return res.status(400).json({ success: false, message: "Invalid action." });
  } catch (err) {
    console.error("processWithdrawalAdmin error:", err);
    return res.status(500).json({ success: false, message: "Server error." });
  }
};