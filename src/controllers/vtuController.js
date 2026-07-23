const { getDb } = require("../config/firebase");
const admin = require("firebase-admin");
const { createNotification } = require("./notificationsController");
const {
  buyAirtimeRemote, buyDataRemote, getDataPlansRemote,
  requeryRemote, genRequestId,
} = require("../utils/mysubwallet");

const NGN_RATE = 1500; // keep in sync with your withdrawal conversion rate

// ─── Config (markup) — mirrors giftCardRates pattern ───────────────────────
const getVtuConfig = async (db) => {
  const doc = await db.collection("vtuConfig").doc("settings").get();
  if (!doc.exists) {
    // sane default if nothing configured yet
    return { airtimeMarkupPercent: 10, dataMarkupPercent: 10, active: true };
  }
  return doc.data();
};

exports.getPublicVtuConfig = async (req, res) => {
  try {
    const db = getDb();
    const cfg = await getVtuConfig(db);
    return res.json({
      success: true,
      data: {
        airtimeMarkupPercent: cfg.airtimeMarkupPercent,
        dataMarkupPercent: cfg.dataMarkupPercent,
        active: cfg.active,
      },
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: "Failed to load VTU config." });
  }
};

// ─── Admin: get/update markup config ───────────────────────────────────────
exports.getVtuConfigAdmin = async (req, res) => {
  try {
    const db = getDb();
    const cfg = await getVtuConfig(db);
    return res.json({ success: true, data: { config: cfg } });
  } catch (err) {
    return res.status(500).json({ success: false, message: "Failed to load config." });
  }
};

exports.updateVtuConfig = async (req, res) => {
  try {
    const db = getDb();
    const { airtimeMarkupPercent, dataMarkupPercent, active } = req.body;
    const data = {
      airtimeMarkupPercent: parseFloat(airtimeMarkupPercent),
      dataMarkupPercent: parseFloat(dataMarkupPercent),
      active: active !== false,
      updatedAt: new Date(),
    };
    await db.collection("vtuConfig").doc("settings").set(data, { merge: true });
    return res.json({ success: true, message: "VTU config saved." });
  } catch (err) {
    return res.status(500).json({ success: false, message: "Failed to save config." });
  }
};

// ─── User: get data plans (marked up) ──────────────────────────────────────
exports.getDataPlans = async (req, res) => {
  try {
    const db = getDb();
    const cfg = await getVtuConfig(db);
    const remote = await getDataPlansRemote();
    const rawPlans = remote.plan || [];

    const plans = rawPlans.map((p) => {
      const costNgn = parseFloat(p.amount || 0);
      const chargeNgn = +(costNgn * (1 + cfg.dataMarkupPercent / 100)).toFixed(2);
      return {
        planId: p.plan_id,
        network: p.network,
        networkType: p.network_type,
        name: p.name,
        costNgn,
        chargeNgn,
        chargeUsd: +(chargeNgn / NGN_RATE).toFixed(2),
      };
    });

    return res.json({ success: true, data: { plans } });
  } catch (err) {
    console.error("getDataPlans error:", err.response?.data || err.message);
    return res.status(500).json({ success: false, message: "Failed to fetch data plans." });
  }
};

// ─── User: buy airtime ──────────────────────────────────────────────────────
exports.buyAirtime = async (req, res) => {
  const db = getDb();
  const uid = req.user.uid;
  const { network, phone, faceValueNgn } = req.body;

  if (!network || !phone || !faceValueNgn) {
    return res.status(400).json({ success: false, message: "Missing required fields." });
  }

  try {
    const cfg = await getVtuConfig(db);
    if (!cfg.active) {
      return res.status(400).json({ success: false, message: "Airtime purchases are temporarily unavailable." });
    }

    const face = parseFloat(faceValueNgn);
    const chargeNgn = +(face * (1 + cfg.airtimeMarkupPercent / 100)).toFixed(2);
    const chargeUsd = +(chargeNgn / NGN_RATE).toFixed(2);

    const userRef = db.collection("users").doc(uid);
    const userDoc = await userRef.get();
    if (!userDoc.exists) return res.status(404).json({ success: false, message: "User not found." });
    const user = userDoc.data();

    if ((user.balance || 0) < chargeUsd) {
      return res.status(400).json({ success: false, message: "Insufficient balance." });
    }

    // ── Deduct FIRST, before calling mySubwallet ──
    await userRef.update({
      balance: admin.firestore.FieldValue.increment(-chargeUsd),
      updatedAt: new Date(),
    });

    const requestId = genRequestId("AIR");
    const txRef = await db.collection("vtuTransactions").add({
      userId: uid,
      type: "airtime",
      network,
      phone,
      faceValueNgn: face,
      chargeNgn,
      chargeUsd,
      requestId,
      status: "processing",
      createdAt: new Date(),
    });

    let remoteResult;
    try {
      remoteResult = await buyAirtimeRemote({
        network, phone, amount: face, requestId,
        sandboxFail: req.body.__sandboxFail === true, // testing only, remove before real launch UI exposes this
      });
    } catch (apiErr) {
      // network/timeout — don't assume failure, requery before refunding
      try {
        remoteResult = await requeryRemote(requestId);
      } catch {
        remoteResult = { status: "fail", message: "Could not confirm transaction status." };
      }
    }

    const succeeded = remoteResult?.status === "success";

    if (succeeded) {
        await txRef.update({
          status: "success",
          remoteResponse: remoteResult,
          remoteTransId: remoteResult.transid,  // add this
          completedAt: new Date(),
        });
      await db.collection("transactions").add({
        userId: uid, type: "airtime", description: `${network_label(network)} Airtime ₦${face}`,
        amount: -chargeUsd, status: "completed", createdAt: new Date(),
      });

      await createNotification(uid, {
        title: "📱 Airtime Purchase Successful",
        body: `₦${face.toLocaleString()} airtime was sent to ${phone} on ${network_label(network)}.`,
        type: "paymentAlerts",
      });

      return res.json({ success: true, message: "Airtime purchase successful.", data: { chargeUsd } });
    } else {
      // refund
      await userRef.update({ balance: admin.firestore.FieldValue.increment(chargeUsd), updatedAt: new Date() });
      await txRef.update({ status: "failed", remoteResponse: remoteResult, completedAt: new Date() });

      await createNotification(uid, {
        title: "⚠️ Airtime Purchase Failed",
        body: `Your ₦${face.toLocaleString()} airtime purchase to ${phone} failed and your balance was refunded.`,
        type: "paymentAlerts",
      });

      return res.status(400).json({
        success: false,
        message: remoteResult?.message || "Airtime purchase failed. You have been refunded.",
      });
    }
  } catch (err) {
    console.error("buyAirtime error:", err.response?.data || err.message);
    return res.status(500).json({ success: false, message: "Server error processing airtime purchase." });
  }
};

// ─── User: buy data ─────────────────────────────────────────────────────────
exports.buyData = async (req, res) => {
  const db = getDb();
  const uid = req.user.uid;
  const { network, phone, planId, costNgn } = req.body;

  if (!network || !phone || !planId || !costNgn) {
    return res.status(400).json({ success: false, message: "Missing required fields." });
  }

  try {
    const cfg = await getVtuConfig(db);
    if (!cfg.active) {
      return res.status(400).json({ success: false, message: "Data purchases are temporarily unavailable." });
    }

    const cost = parseFloat(costNgn);
    const chargeNgn = +(cost * (1 + cfg.dataMarkupPercent / 100)).toFixed(2);
    const chargeUsd = +(chargeNgn / NGN_RATE).toFixed(2);

    const userRef = db.collection("users").doc(uid);
    const userDoc = await userRef.get();
    if (!userDoc.exists) return res.status(404).json({ success: false, message: "User not found." });
    const user = userDoc.data();

    if ((user.balance || 0) < chargeUsd) {
      return res.status(400).json({ success: false, message: "Insufficient balance." });
    }

    await userRef.update({
      balance: admin.firestore.FieldValue.increment(-chargeUsd),
      updatedAt: new Date(),
    });

    const requestId = genRequestId("DATA");
    const txRef = await db.collection("vtuTransactions").add({
      userId: uid,
      type: "data",
      network,
      phone,
      planId,
      costNgn: cost,
      chargeNgn,
      chargeUsd,
      requestId,
      status: "processing",
      createdAt: new Date(),
    });

    let remoteResult;
    try {
      remoteResult = await buyDataRemote({ network, phone, dataPlan: planId, requestId });
    } catch (apiErr) {
      try {
        remoteResult = await requeryRemote(requestId);
      } catch {
        remoteResult = { status: "fail", message: "Could not confirm transaction status." };
      }
    }

    const succeeded = remoteResult?.status === "success";

    if (succeeded) {
      await txRef.update({
        status: "success",
        remoteResponse: remoteResult,
        remoteTransId: remoteResult.transid,
        completedAt: new Date(),
      });
      await db.collection("transactions").add({
        userId: uid, type: "data", description: `${network_label(network)} Data — ${remoteResult.dataplan || planId}`,
        amount: -chargeUsd, status: "completed", createdAt: new Date(),
      });

      await createNotification(uid, {
        title: "📶 Data Purchase Successful",
        body: `${remoteResult.dataplan || "Data plan"} was sent to ${phone} on ${network_label(network)}.`,
        type: "paymentAlerts",
      });

      return res.json({ success: true, message: "Data purchase successful.", data: { chargeUsd } });
    } else {
      await userRef.update({ balance: admin.firestore.FieldValue.increment(chargeUsd), updatedAt: new Date() });
      await txRef.update({ status: "failed", remoteResponse: remoteResult, completedAt: new Date() });

      await createNotification(uid, {
        title: "⚠️ Data Purchase Failed",
        body: `Your data purchase to ${phone} failed and your balance was refunded.`,
        type: "paymentAlerts",
      });

      return res.status(400).json({
        success: false,
        message: remoteResult?.message || "Data purchase failed. You have been refunded.",
      });
    }
  } catch (err) {
    console.error("buyData error:", err.response?.data || err.message);
    return res.status(500).json({ success: false, message: "Server error processing data purchase." });
  }
};

// ─── Admin: live wallet balance from mySubwallet ───────────────────────────
exports.getVtuBalanceAdmin = async (req, res) => {
  try {
    const { getBalanceRemote } = require("../utils/mysubwallet");
    const remote = await getBalanceRemote();
    return res.json({ success: true, data: remote });
  } catch (err) {
    console.error("getVtuBalanceAdmin error:", err.response?.data || err.message);
    return res.status(500).json({ success: false, message: "Failed to fetch balance." });
  }
};

function network_label(id) {
  return { 1: "MTN", 2: "Airtel", 3: "Glo", 4: "9mobile" }[id] || "Network";
}