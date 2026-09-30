/**
 * jobs/boostSyncJob.js — keeps Boost order statuses in sync with Shoprime.
 * Start once from server.js:  require("./jobs/boostSyncJob").startBoostSyncJob();
 */
const cron = require("node-cron");
const { getDb } = require("../config/firebase");
const { getStatuses } = require("../utils/smmProvider");
const { createNotification } = require("../controllers/notificationsController");
const { round4, toMs, refundOrder } = require("../utils/boostHelpers");

let running = false; // prevents overlapping runs

const COMPLETED = ["completed", "complete", "success"];
const CANCELED  = ["canceled", "cancelled", "refunded", "fail", "failed"];
const ACTIVE    = ["in progress", "inprogress", "processing"];

const applyStatus = async (db, order, s) => {
  const st = String(s.status || "").toLowerCase().trim();
  const ref = db.collection("boostOrders").doc(order.id);

  if (COMPLETED.includes(st)) {
    await ref.update({ status: "completed", finishedAt: new Date(), updatedAt: new Date(), startCount: s.start_count ?? null });
    await createNotification(order.userId, {
      title: "✅ Boost Completed",
      body: `Your ${order.serviceName} order (${order.quantity.toLocaleString()}) has been delivered.`,
      type: "paymentAlerts",
    }).catch(() => {});
    return;
  }

  if (st === "partial") {
    const undelivered = Math.min(parseInt(s.remains) || 0, order.quantity);
    const refund = round4((order.chargeUsd * undelivered) / order.quantity);
    if (refund <= 0) {
      await ref.update({ status: "completed", finishedAt: new Date(), updatedAt: new Date() });
    } else {
      await refundOrder(order.id, {
        amountUsd: refund,
        status: "partial",
        note: `${order.quantity - undelivered} of ${order.quantity} delivered`,
      });
    }
    return;
  }

  if (CANCELED.includes(st)) {
    await refundOrder(order.id, { amountUsd: order.chargeUsd, status: "canceled", note: "Canceled by provider." });
    return;
  }

  if (ACTIVE.includes(st) && order.status !== "in_progress") {
    await ref.update({ status: "in_progress", updatedAt: new Date() });
  }
  // "pending" → nothing to do yet
};

const syncBoostOrders = async () => {
  if (running) return;
  running = true;
  try {
    const db = getDb();

    // 1) Open orders → ask the provider for their status
    const snap = await db.collection("boostOrders").where("status", "in", ["pending", "in_progress"]).get();
    const orders = snap.docs.map((d) => ({ id: d.id, ...d.data() })).filter((o) => o.providerOrderId);

    if (orders.length) {
      let statuses;
      try {
        statuses = await getStatuses(orders.map((o) => o.providerOrderId));
      } catch (e) {
        console.error("Boost sync: status call failed:", e.message);
        statuses = null;
      }
      if (statuses) {
        for (const o of orders) {
          const s = statuses[o.providerOrderId];
          if (!s || s.error) {
            console.error(`Boost sync: no status for order ${o.id} (${o.providerOrderId})`, s?.error || "");
            continue;
          }
          try { await applyStatus(db, o, s); }
          catch (e) { console.error(`Boost sync: failed to apply status for ${o.id}:`, e.message); }
        }
      }
    }

    // 2) Orders stuck in "submitting" (server crashed mid-request) → flag for admin review
    const stuck = await db.collection("boostOrders").where("status", "==", "submitting").get();
    for (const d of stuck.docs) {
      if (toMs(d.data().createdAt) < Date.now() - 10 * 60000) {
        await d.ref.update({ status: "needs_review", updatedAt: new Date() });
        console.error("⚠️ BOOST order stuck in submitting → needs_review:", d.id);
      }
    }
  } catch (err) {
    console.error("Boost sync error:", err);
  } finally {
    running = false;
  }
};

const startBoostSyncJob = () => {
  cron.schedule("*/4 * * * *", () => syncBoostOrders().catch(console.error)); // every 4 minutes
  console.log("✅ Boost sync job scheduled (every 4 min)");
};

module.exports = { syncBoostOrders, startBoostSyncJob };