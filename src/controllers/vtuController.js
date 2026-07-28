const { getDb } = require("../config/firebase");
const admin = require("firebase-admin");
const {
  createNotification,
  notifyAdminsLowVtuBalance,
  markVtuLowBalanceResolved,
} = require("./notificationsController");
const {
  buyAirtimeRemote, buyDataRemote, getDataPlansRemote, getBalanceRemote,
  requeryRemote, genRequestId, isInsufficientBalanceError,
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
    let pendingTopup = false;

    try {
      remoteResult = await buyAirtimeRemote({
        network, phone, amount: face, requestId,
        sandboxFail: req.body.__sandboxFail === true, // testing only, remove before real launch UI exposes this
      });
    } catch (apiErr) {
      if (isInsufficientBalanceError(apiErr)) {
        pendingTopup = true;
      } else {
        // network/timeout/other — don't assume failure, requery before refunding
        try {
          remoteResult = await requeryRemote(requestId);
        } catch {
          remoteResult = { status: "fail", message: "Could not confirm transaction status." };
        }
      }
    }

    // ── mySubwallet float is empty — queue the order rather than fail it.
    // The user's balance stays deducted (they're still owed this order,
    // it's not a failure). Admins get a debounced in-app alert. A retry
    // job / manual admin trigger fulfills it once float is topped up.
    if (pendingTopup) {
      await txRef.update({
        status: "pending_topup",
        pendingReason: "insufficient_float",
        updatedAt: new Date(),
      });

      await notifyAdminsLowVtuBalance(db);

      await createNotification(uid, {
        title: "⏳ Airtime Order Received",
        body: `Your ₦${face.toLocaleString()} airtime order to ${phone} is queued and will be delivered shortly.`,
        type: "paymentAlerts",
      });

      return res.json({
        success: true,
        pending: true,
        message: "Your order has been received and will be delivered shortly.",
        data: { chargeUsd },
      });
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
    let pendingTopup = false;

    try {
      remoteResult = await buyDataRemote({ network, phone, dataPlan: planId, requestId });
    } catch (apiErr) {
      if (isInsufficientBalanceError(apiErr)) {
        pendingTopup = true;
      } else {
        try {
          remoteResult = await requeryRemote(requestId);
        } catch {
          remoteResult = { status: "fail", message: "Could not confirm transaction status." };
        }
      }
    }

    if (pendingTopup) {
      await txRef.update({
        status: "pending_topup",
        pendingReason: "insufficient_float",
        updatedAt: new Date(),
      });

      await notifyAdminsLowVtuBalance(db);

      await createNotification(uid, {
        title: "⏳ Data Order Received",
        body: `Your data order to ${phone} is queued and will be delivered shortly.`,
        type: "paymentAlerts",
      });

      return res.json({
        success: true,
        pending: true,
        message: "Your order has been received and will be delivered shortly.",
        data: { chargeUsd },
      });
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
    const remote = await getBalanceRemote();
    return res.json({ success: true, data: remote });
  } catch (err) {
    console.error("getVtuBalanceAdmin error:", err.response?.data || err.message);
    return res.status(500).json({ success: false, message: "Failed to fetch balance." });
  }
};

// ─── Admin: list orders stuck waiting on mySubwallet topup ─────────────────
exports.getPendingVtuQueue = async (req, res) => {
  try {
    const db = getDb();
    const snap = await db.collection("vtuTransactions")
      .where("status", "==", "pending_topup")
      .get();

    const orders = snap.docs
      .map((doc) => ({ id: doc.id, ...doc.data() }))
      .sort((a, b) => (a.createdAt?._seconds || 0) - (b.createdAt?._seconds || 0));

    const totalNgnNeeded = orders.reduce((sum, o) => sum + (o.chargeNgn || 0), 0);

    return res.json({
      success: true,
      data: { orders, count: orders.length, totalNgnNeeded },
    });
  } catch (err) {
    console.error("getPendingVtuQueue error:", err.response?.data || err.message);
    return res.status(500).json({ success: false, message: "Failed to fetch pending queue." });
  }
};

// ─── Core fulfillment logic: retry all pending_topup orders ───────────────
// Called by:
//   1. The cron poller (runs on a schedule, checks float automatically)
//   2. The manual admin "process queue" endpoint (instant, after a topup)
//
// Behavior:
//   - Re-checks LIVE mySubwallet balance before every single order — if
//     float runs out mid-batch, stops immediately and leaves the rest
//     queued for the next run (never assumes float based on a stale read).
//   - On success: marks the order complete, writes the ledger entry,
//     notifies the user their order was delivered.
//   - On a genuine failure (not a balance issue — e.g. bad phone number
//     that somehow got this far, provider-side rejection): refunds the
//     user and notifies them, same as the original purchase flow does.
//   - If insufficient-balance happens again mid-retry: leaves that order
//     (and everything after it) queued, does NOT refund — it's not a
//     failure, just still waiting.
//   - Once the queue is fully drained, clears the admin alert so the next
//     low-balance episode raises a fresh notification.
exports.retryPendingVtuOrders = async () => {
  const db = getDb();
  const summary = { attempted: 0, succeeded: 0, failed: 0, stoppedEarly: false };

  const snap = await db.collection("vtuTransactions")
    .where("status", "==", "pending_topup")
    .get();

  const orders = snap.docs
    .map((doc) => ({ id: doc.id, ref: doc.ref, ...doc.data() }))
    .sort((a, b) => (a.createdAt?._seconds || 0) - (b.createdAt?._seconds || 0));

  for (const order of orders) {
    // Re-check live float before each attempt
    let liveBalanceNgn;
    try {
      const bal = await getBalanceRemote();
      liveBalanceNgn = parseFloat(bal.balance || 0);
    } catch {
      summary.stoppedEarly = true;
      break; // mySubwallet unreachable right now — stop, next run retries
    }

    if (liveBalanceNgn < order.chargeNgn) {
      summary.stoppedEarly = true;
      break; // not enough float for this order — stop, leave rest queued
    }

    summary.attempted++;

    let remoteResult;
    let stillInsufficient = false;

    try {
      remoteResult = order.type === "airtime"
        ? await buyAirtimeRemote({
            network: order.network, phone: order.phone,
            amount: order.faceValueNgn, requestId: order.requestId,
          })
        : await buyDataRemote({
            network: order.network, phone: order.phone,
            dataPlan: order.planId, requestId: order.requestId,
          });
    } catch (apiErr) {
      if (isInsufficientBalanceError(apiErr)) {
        stillInsufficient = true;
      } else {
        try {
          remoteResult = await requeryRemote(order.requestId);
        } catch {
          remoteResult = { status: "fail", message: "Could not confirm transaction status." };
        }
      }
    }

    if (stillInsufficient) {
      summary.stoppedEarly = true;
      break; // float ran out mid-batch — stop, leave this and rest queued
    }

    const succeeded = remoteResult?.status === "success";

    if (succeeded) {
      await order.ref.update({
        status: "success",
        remoteResponse: remoteResult,
        remoteTransId: remoteResult.transid,
        completedAt: new Date(),
      });

      const desc = order.type === "airtime"
        ? `${network_label(order.network)} Airtime ₦${order.faceValueNgn}`
        : `${network_label(order.network)} Data — ${remoteResult.dataplan || order.planId}`;

      await db.collection("transactions").add({
        userId: order.userId, type: order.type, description: desc,
        amount: -order.chargeUsd, status: "completed", createdAt: new Date(),
      });

      await createNotification(order.userId, {
        title: order.type === "airtime" ? "📱 Airtime Delivered" : "📶 Data Delivered",
        body: order.type === "airtime"
          ? `₦${order.faceValueNgn.toLocaleString()} airtime was sent to ${order.phone}.`
          : `${remoteResult.dataplan || "Your data plan"} was sent to ${order.phone}.`,
        type: "paymentAlerts",
      });

      summary.succeeded++;
    } else {
      // Genuine failure on retry (not a balance issue) — refund
      await db.collection("users").doc(order.userId).update({
        balance: admin.firestore.FieldValue.increment(order.chargeUsd),
        updatedAt: new Date(),
      });
      await order.ref.update({ status: "failed", remoteResponse: remoteResult, completedAt: new Date() });

      await createNotification(order.userId, {
        title: order.type === "airtime" ? "⚠️ Airtime Purchase Failed" : "⚠️ Data Purchase Failed",
        body: "Your queued order could not be delivered and your balance was refunded.",
        type: "paymentAlerts",
      });

      summary.failed++;
    }
  }

  // If nothing is left pending, clear the admin alert
  const remainingSnap = await db.collection("vtuTransactions")
    .where("status", "==", "pending_topup").limit(1).get();
  if (remainingSnap.empty) {
    await markVtuLowBalanceResolved(db);
  }

  return summary;
};

// ─── Admin: manually trigger queue processing (e.g. right after a topup) ──
exports.processVtuQueueAdmin = async (req, res) => {
  try {
    const summary = await exports.retryPendingVtuOrders();
    return res.json({ success: true, message: "Queue processed.", data: summary });
  } catch (err) {
    console.error("processVtuQueueAdmin error:", err);
    return res.status(500).json({ success: false, message: "Failed to process queue." });
  }
};

function network_label(id) {
  return { 1: "MTN", 2: "Airtel", 3: "Glo", 4: "9mobile" }[id] || "Network";
}