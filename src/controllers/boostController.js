/**
 * controllers/boostController.js — PromoEarn Boost (SMM reseller)
 *
 * User endpoints:
 *   listServices, listMyOrders
 *   createOrder        → pay from PromoEarn balance
 *   createCardOrder    → pay with Flutterwave (card / bank transfer)
 *   verifyCardOrder    → app calls this after the Flutterwave checkout closes
 *
 * Also exported for paymentController (Flutterwave webhook):
 *   settleBoostPayment, fulfillPaidBoostOrder
 *
 * Admin endpoints: adminGetConfig/UpdateConfig, adminGetBalance, adminSyncServices,
 *   adminGetServices, adminUpdateService, adminGetOrders, adminRefundOrder, adminAttachOrder
 */
const { getDb } = require("../config/firebase");
const provider = require("../utils/smmProvider");
const { flw } = require("../utils/flutterwave");
const { checkVersionGate } = require("../utils/versionCheck");
const { createNotification } = require("./notificationsController");
const {
  BOOST_CONFIG_DEFAULTS, round4, toMs, getBoostConfig,
  userRatePer1000Usd, calcCharge, guessPlatform, validateLink, refundOrder,
} = require("../utils/boostHelpers");

const NGN_RATE = 1500;     // same fixed rate the rest of PromoEarn uses ($1 = ₦1,500)
const MIN_CARD_NGN = 100;  // smallest card payment we accept

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

// ═════════════════════════════════════════════════════════════════════════
// SHARED HELPERS
// ═════════════════════════════════════════════════════════════════════════

// Validates service / quantity / link, prices the order on the server, and applies
// limits. Used by BOTH the balance flow and the card flow.
async function prepareOrder(req) {
  const db  = getDb();
  const uid = req.user.uid;
  const serviceId = String(req.body.serviceId || "");
  const quantity  = parseInt(req.body.quantity);

  const cfg = await getBoostConfig();
  if (!cfg.boostEnabled) throw new HttpError(503, "Boost is temporarily unavailable. Please try again later.");

  const svcSnap = await db.collection("boostServices").doc(serviceId).get();
  if (!svcSnap.exists || !svcSnap.data().enabled) throw new HttpError(400, "This service is not available.");
  const svc = svcSnap.data();

  if (!quantity || quantity < svc.min || quantity > svc.max) {
    throw new HttpError(400, `Quantity must be between ${svc.min} and ${svc.max}.`);
  }
  const link = validateLink(req.body.link, svc.platform);
  if (!link) throw new HttpError(400, `Please enter a valid ${svc.platform} link (https://...).`);

  const { costUsd, chargeUsd } = calcCharge(svc, quantity, cfg);
  if (chargeUsd > cfg.maxOrderUsd) {
    throw new HttpError(400, `Orders are currently limited to $${cfg.maxOrderUsd}. Please reduce the quantity.`);
  }

  // Rate limit + duplicate check (single equality query → no composite index needed)
  const mineSnap = await db.collection("boostOrders").where("userId", "==", uid).get();
  const mine = mineSnap.docs.map((d) => d.data());
  const now = Date.now();
  const placed = mine.filter((o) => o.status !== "awaiting_payment");

  if (placed.filter((o) => toMs(o.createdAt) > now - 3600000).length >= cfg.maxOrdersPerHour) {
    throw new HttpError(429, "Too many orders. Please wait a while and try again.");
  }
  if (mine.filter((o) => o.status === "awaiting_payment" && toMs(o.createdAt) > now - 3600000).length >= 5) {
    throw new HttpError(429, "You have several unpaid orders. Please finish or wait before starting another.");
  }
  const dup = placed.find(
    (o) => o.link === link && o.serviceId === serviceId &&
           toMs(o.createdAt) > now - 10 * 60000 && !["failed", "canceled"].includes(o.status)
  );
  if (dup) throw new HttpError(400, "You already placed this order recently. Please wait for it to finish.");

  return { uid, serviceId, svc, link, quantity, costUsd, chargeUsd };
}

// Sends an already-paid order to Shoprime and records the outcome.
// Returns "pending" | "failed" | "needs_review".
async function dispatchToProvider(orderId, o) {
  const orderRef = getDb().collection("boostOrders").doc(orderId);
  try {
    const providerOrderId = await provider.addOrder({
      service: o.providerServiceId, link: o.link, quantity: o.quantity,
    });
    await orderRef.update({ status: "pending", providerOrderId, submittedAt: new Date(), updatedAt: new Date() });
    return "pending";
  } catch (e) {
    if (e instanceof provider.ProviderError && e.definitive) {
      // Provider clearly refused → order does not exist there → refund to PromoEarn balance
      if (/fund|balance|credit/i.test(e.message)) {
        console.error("🚨 BOOST: provider balance may be empty — top up Shoprime!", e.message);
      }
      await orderRef.update({ providerError: e.message });
      await refundOrder(orderId, {
        amountUsd: o.chargeUsd, status: "failed", note: "Provider rejected the order.",
      });
      return "failed";
    }
    // Outcome unknown (timeout etc.) → do NOT refund automatically; admin reviews
    console.error("⚠️ BOOST order needs review (unknown provider outcome):", orderId, e.message);
    await orderRef.update({ status: "needs_review", providerError: e.message, updatedAt: new Date() });
    return "needs_review";
  }
}

const cardMessage = (outcome) => {
  switch (outcome) {
    case "pending":
      return "Payment confirmed and order placed! We'll update the status as it's delivered.";
    case "needs_review":
      return "Payment confirmed. Your order is being confirmed and will update shortly.";
    case "failed":
      return "Payment received, but we couldn't place this order. The amount was refunded to your PromoEarn balance.";
    case "already":
      return "This order has already been processed. Check My orders for its status.";
    default:
      return "Payment received.";
  }
};

// ─────────────────────────────────────────────────────────────────────────
// Called after a Flutterwave payment is confirmed (by the app's verify call OR
// by the webhook — whichever arrives first). Safe to call twice: only the first
// call moves the order out of "awaiting_payment", the second returns "already".
// ─────────────────────────────────────────────────────────────────────────
async function fulfillPaidBoostOrder(orderId, txData) {
  const db  = getDb();
  const ref = db.collection("boostOrders").doc(orderId);
  let claimed = null;
  let mismatch = false;

  await db.runTransaction(async (t) => {
    const snap = await t.get(ref);
    if (!snap.exists) return;
    const o = snap.data();
    if (o.status !== "awaiting_payment") return; // already handled

    const paid = Number(txData.amount) || 0;
    const paymentOk =
      txData.status === "successful" &&
      txData.currency === "NGN" &&
      txData.tx_ref === o.flwTxRef &&
      paid + 1 >= o.chargeNgn;

    if (!paymentOk) {
      mismatch = true;
      t.update(ref, {
        status: "needs_review",
        providerError: `Payment check failed: paid ${paid} ${txData.currency}, expected N${o.chargeNgn}`,
        flwTransactionId: txData.id || null,
        updatedAt: new Date(),
      });
      return;
    }

    t.update(ref, {
      status: "submitting",
      paidNgn: paid,
      paidAt: new Date(),
      flwTransactionId: txData.id || null,
      updatedAt: new Date(),
    });
    claimed = { ...o };
  });

  if (mismatch) return { outcome: "mismatch" };
  if (!claimed)  return { outcome: "already" };

  const outcome = await dispatchToProvider(orderId, claimed);

  try {
    await createNotification(claimed.userId, {
      title: outcome === "failed" ? "⚠️ Boost order refunded" : "🚀 Boost order received",
      body:  cardMessage(outcome),
      type:  "paymentAlerts",
    });
  } catch {}

  return { outcome };
}

// Webhook entry point: finds the order from the Flutterwave tx_ref
// (PE-BOOST-<orderId>-<timestamp>) — does not rely on Flutterwave echoing `meta`.
async function settleBoostPayment(txData) {
  const ref = String(txData.tx_ref || "");
  const snap = await getDb().collection("boostOrders").where("flwTxRef", "==", ref).limit(1).get();
  if (snap.empty) throw new Error(`Boost order not found for reference ${ref}`);
  return fulfillPaidBoostOrder(snap.docs[0].id, txData);
}

exports.settleBoostPayment = settleBoostPayment;
exports.fulfillPaidBoostOrder = fulfillPaidBoostOrder;

// ═════════════════════════════════════════════════════════════════════════
// USER ENDPOINTS
// ═════════════════════════════════════════════════════════════════════════

// GET /boost/services
exports.listServices = async (req, res) => {
  try {
    const db  = getDb();
    const cfg = await getBoostConfig();
    const snap = await db.collection("boostServices").where("enabled", "==", true).get();

    const services = snap.docs
      .map((d) => {
        const s = d.data();
        return {
          id: d.id,
          name: s.name,
          platform: s.platform,
          category: s.category || "",
          min: s.min,
          max: s.max,
          refill: !!s.refill,
          pricePer1000Usd: userRatePer1000Usd(s, cfg), // provider cost & markup are never exposed
        };
      })
      .sort((a, b) => a.platform.localeCompare(b.platform) || a.pricePer1000Usd - b.pricePer1000Usd);

    return res.json({
      success: true,
      data: { services, enabled: cfg.boostEnabled, ngnRate: NGN_RATE, minCardNgn: MIN_CARD_NGN },
    });
  } catch (err) {
    console.error("Boost listServices error:", err);
    return res.status(500).json({ success: false, message: "Failed to load services." });
  }
};

// POST /boost/order   { serviceId, link, quantity }   → pay from balance
exports.createOrder = async (req, res) => {
  try {
    const gate = await checkVersionGate(req, getDb);
    if (gate) return res.status(gate.status).json(gate.body);

    const db = getDb();
    const { uid, serviceId, svc, link, quantity, costUsd, chargeUsd } = await prepareOrder(req);

    // ── Deduct balance + create order atomically ──────────────────────────
    const orderRef = db.collection("boostOrders").doc();
    const userRef  = db.collection("users").doc(uid);
    let newBalance;

    await db.runTransaction(async (t) => {
      const uSnap = await t.get(userRef);
      if (!uSnap.exists) throw new HttpError(404, "User not found.");
      const u = uSnap.data();
      if (u.isBanned) throw new HttpError(403, "Your account is suspended.");
      const bal = u.balance || 0;
      if (bal < chargeUsd) throw new HttpError(400, `Insufficient balance. You need $${chargeUsd.toFixed(2)}.`);

      newBalance = round4(bal - chargeUsd);
      t.update(userRef, { balance: newBalance, updatedAt: new Date() });
      t.set(orderRef, {
        userId: uid,
        username: u.username || "",
        serviceId,
        providerServiceId: svc.providerServiceId,
        serviceName: svc.name,
        platform: svc.platform,
        link,
        quantity,
        chargeUsd,
        costUsd,
        paymentMethod: "balance",
        status: "submitting",
        refundedUsd: 0,
        providerOrderId: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      t.set(db.collection("transactions").doc(), {
        userId: uid,
        type: "boost",
        description: `Boost: ${svc.name} x${quantity}`,
        amount: -chargeUsd,
        status: "completed",
        orderId: orderRef.id,
        createdAt: new Date(),
      });
    });

    const outcome = await dispatchToProvider(orderRef.id, {
      providerServiceId: svc.providerServiceId, link, quantity, chargeUsd,
    });

    if (outcome === "pending") {
      return res.status(201).json({
        success: true,
        message: "Order placed! We'll update the status as it's delivered.",
        data: { orderId: orderRef.id, status: "pending", chargeUsd, newBalance },
      });
    }
    if (outcome === "failed") {
      return res.status(502).json({
        success: false,
        message: "We couldn't place this order right now. You have not been charged.",
      });
    }
    return res.status(202).json({
      success: true,
      message: "Your order is being confirmed. We'll update you shortly.",
      data: { orderId: orderRef.id, status: "needs_review", chargeUsd, newBalance },
    });
  } catch (err) {
    if (err instanceof HttpError) return res.status(err.status).json({ success: false, message: err.message });
    console.error("Boost createOrder error:", err);
    return res.status(500).json({ success: false, message: "Something went wrong. Please try again." });
  }
};

// POST /boost/order/card   { serviceId, link, quantity }   → starts Flutterwave checkout
exports.createCardOrder = async (req, res) => {
  const db = getDb();
  let orderRef = null;
  try {
    const gate = await checkVersionGate(req, getDb);
    if (gate) return res.status(gate.status).json(gate.body);

    const { uid, serviceId, svc, link, quantity, costUsd, chargeUsd } = await prepareOrder(req);

    const chargeNgn = Math.ceil(chargeUsd * NGN_RATE);
    if (chargeNgn < MIN_CARD_NGN) {
      throw new HttpError(400, `Card payments start at ₦${MIN_CARD_NGN}. Increase the quantity or pay from your balance.`);
    }

    const uSnap = await db.collection("users").doc(uid).get();
    if (!uSnap.exists) throw new HttpError(404, "User not found.");
    const u = uSnap.data();
    if (u.isBanned) throw new HttpError(403, "Your account is suspended.");

    orderRef = db.collection("boostOrders").doc();
    const tx_ref = `PE-BOOST-${orderRef.id}-${Date.now()}`;

    // Saved BEFORE payment so the webhook can always find it. Not sent to the provider yet.
    await orderRef.set({
      userId: uid,
      username: u.username || "",
      serviceId,
      providerServiceId: svc.providerServiceId,
      serviceName: svc.name,
      platform: svc.platform,
      link,
      quantity,
      chargeUsd,
      chargeNgn,
      costUsd,
      paymentMethod: "card",
      flwTxRef: tx_ref,
      status: "awaiting_payment",
      refundedUsd: 0,
      providerOrderId: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const email = u.email || req.user.email;
    const { data } = await flw.post("/payments", {
      tx_ref,
      amount: chargeNgn,
      currency: "NGN",
      redirect_url: `${process.env.CLIENT_URL}/payment-success`,
      customer: {
        email,
        name: `${u.firstName || ""} ${u.lastName || ""}`.trim() || email,
      },
      customizations: {
        title: "PromoEarn Boost",
        description: `${svc.name} x${quantity}`,
      },
      meta: { userId: uid, purpose: "boost", orderId: orderRef.id, tx_ref },
    });

    if (data.status !== "success") {
      console.error("Flutterwave boost init error:", data);
      await orderRef.delete().catch(() => {});
      throw new HttpError(502, data.message || "Couldn't start the payment. Please try again.");
    }

    return res.status(201).json({
      success: true,
      data: {
        orderId: orderRef.id,
        url: data.data.link,
        reference: tx_ref,
        amountNgn: chargeNgn,
        chargeUsd,
      },
    });
  } catch (err) {
    if (err instanceof HttpError) return res.status(err.status).json({ success: false, message: err.message });
    console.error("Boost createCardOrder error:", err.response?.data || err.message);
    if (orderRef) await orderRef.delete().catch(() => {});
    return res.status(500).json({ success: false, message: "Couldn't start the payment. Please try again." });
  }
};

// POST /boost/order/card/verify   { reference }
exports.verifyCardOrder = async (req, res) => {
  try {
    const db = getDb();
    const reference = String(req.body.reference || "");
    if (!reference.startsWith("PE-BOOST-")) {
      return res.status(400).json({ success: false, message: "Invalid payment reference." });
    }

    const snap = await db.collection("boostOrders").where("flwTxRef", "==", reference).limit(1).get();
    if (snap.empty) return res.status(404).json({ success: false, message: "Order not found." });
    const doc = snap.docs[0];
    if (doc.data().userId !== req.user.uid) {
      return res.status(403).json({ success: false, message: "Not your order." });
    }

    // The webhook may already have processed it
    if (doc.data().status !== "awaiting_payment") {
      return res.json({ success: true, message: cardMessage("already"), data: { orderId: doc.id, status: "already" } });
    }

    const { data: verifyRes } = await flw.get(
      `/transactions/verify_by_reference?tx_ref=${encodeURIComponent(reference)}`
    );
    if (verifyRes.status !== "success" || verifyRes.data?.status !== "successful") {
      return res.status(400).json({
        success: false,
        message: "Payment not confirmed yet. If you completed it, wait a moment and tap again.",
      });
    }

    const result = await fulfillPaidBoostOrder(doc.id, verifyRes.data);
    if (result.outcome === "mismatch") {
      return res.status(409).json({
        success: false,
        message: "We received your payment but the amount didn't match the order. Please contact support.",
      });
    }
    return res.json({
      success: true,
      message: cardMessage(result.outcome),
      data: { orderId: doc.id, status: result.outcome },
    });
  } catch (err) {
    console.error("Boost verifyCardOrder error:", err.response?.data || err.message);
    return res.status(500).json({ success: false, message: "Couldn't verify the payment. Please try again." });
  }
};

// GET /boost/orders
exports.listMyOrders = async (req, res) => {
  try {
    const db = getDb();
    const snap = await db.collection("boostOrders").where("userId", "==", req.user.uid).get();
    const now = Date.now();
    const orders = snap.docs
      .map((d) => {
        const o = d.data();
        return {
          id: d.id,
          serviceName: o.serviceName,
          platform: o.platform,
          link: o.link,
          quantity: o.quantity,
          chargeUsd: o.chargeUsd,
          chargeNgn: o.chargeNgn || null,
          paymentMethod: o.paymentMethod || "balance",
          refundedUsd: o.refundedUsd || 0,
          // "needs_review" is shown to users as in-progress
          status: o.status === "needs_review" || o.status === "submitting" ? "pending" : o.status,
          createdAt: o.createdAt,
        };
      })
      // hide unpaid card orders that were abandoned more than a day ago
      .filter((o) => !(o.status === "awaiting_payment" && toMs(o.createdAt) < now - 24 * 3600000))
      .sort((a, b) => toMs(b.createdAt) - toMs(a.createdAt))
      .slice(0, 50);
    return res.json({ success: true, data: { orders } });
  } catch (err) {
    console.error("Boost listMyOrders error:", err);
    return res.status(500).json({ success: false, message: "Failed to load orders." });
  }
};

// ═════════════════════════════════════════════════════════════════════════
// ADMIN ENDPOINTS (mounted under adminMiddleware)
// ═════════════════════════════════════════════════════════════════════════

exports.adminGetConfig = async (req, res) => {
  try {
    return res.json({ success: true, data: { config: await getBoostConfig() } });
  } catch (err) {
    return res.status(500).json({ success: false, message: "Failed to load config." });
  }
};

exports.adminUpdateConfig = async (req, res) => {
  try {
    const b = req.body, u = {};
    if (b.boostEnabled !== undefined)     u.boostEnabled = !!b.boostEnabled;
    if (b.maxOrderUsd !== undefined)      u.maxOrderUsd = parseFloat(b.maxOrderUsd);
    if (b.maxOrdersPerHour !== undefined) u.maxOrdersPerHour = parseInt(b.maxOrdersPerHour);
    if (b.defaultMarkup !== undefined) {
      const m = parseFloat(b.defaultMarkup);
      if (!(m >= 1)) return res.status(400).json({ success: false, message: "Markup must be 1 or more." });
      u.defaultMarkup = m;
    }
    if (b.providerCurrency !== undefined) {
      const c = String(b.providerCurrency).toUpperCase();
      if (!["NGN", "USD"].includes(c)) return res.status(400).json({ success: false, message: "Currency must be NGN or USD." });
      u.providerCurrency = c;
    }
    await getDb().collection("config").doc("boost").set(u, { merge: true });
    return res.json({ success: true, data: { config: await getBoostConfig() } });
  } catch (err) {
    console.error("Boost updateConfig error:", err);
    return res.status(500).json({ success: false, message: "Failed to update config." });
  }
};

// Your balance at Shoprime
exports.adminGetBalance = async (req, res) => {
  try {
    const data = await provider.getBalance();
    return res.json({ success: true, data });
  } catch (err) {
    return res.status(502).json({ success: false, message: err.message });
  }
};

// Pull Shoprime's catalog into Firestore. New services arrive DISABLED;
// existing services keep your name / markup / enabled flag and only refresh provider fields.
exports.adminSyncServices = async (req, res) => {
  try {
    const db = getDb();
    const list = await provider.getServices();
    const existing = new Set((await db.collection("boostServices").get()).docs.map((d) => d.id));

    let created = 0, updated = 0;
    for (let i = 0; i < list.length; i += 400) {
      const batch = db.batch();
      for (const s of list.slice(i, i + 400)) {
        const id  = `sp_${s.service}`;
        const ref = db.collection("boostServices").doc(id);
        const providerFields = {
          providerServiceId:   String(s.service),
          providerName:        s.name || "",
          providerRatePer1000: parseFloat(s.rate) || 0,
          min:                 parseInt(s.min) || 1,
          max:                 parseInt(s.max) || 1,
          category:            s.category || "",
          refill:              !!s.refill,
          cancel:              !!s.cancel,
          lastSyncedAt:        new Date(),
        };
        if (existing.has(id)) {
          batch.set(ref, providerFields, { merge: true });
          updated++;
        } else {
          batch.set(ref, {
            ...providerFields,
            name:      s.name || `Service ${s.service}`,
            platform:  guessPlatform(`${s.category} ${s.name}`),
            enabled:   false,
            markup:    null, // null → uses config.defaultMarkup
            createdAt: new Date(),
          }, { merge: true });
          created++;
        }
      }
      await batch.commit();
    }
    return res.json({ success: true, message: `Synced ${list.length} services (${created} new, ${updated} updated).` });
  } catch (err) {
    console.error("Boost syncServices error:", err);
    return res.status(502).json({ success: false, message: err.message || "Sync failed." });
  }
};

exports.adminGetServices = async (req, res) => {
  try {
    const cfg = await getBoostConfig();
    const snap = await getDb().collection("boostServices").get();
    const services = snap.docs.map((d) => {
      const s = d.data();
      return { id: d.id, ...s, userPricePer1000Usd: userRatePer1000Usd(s, cfg) };
    });
    return res.json({ success: true, data: { services } });
  } catch (err) {
    return res.status(500).json({ success: false, message: "Failed to load services." });
  }
};

exports.adminUpdateService = async (req, res) => {
  try {
    const ref = getDb().collection("boostServices").doc(req.params.id);
    if (!(await ref.get()).exists) return res.status(404).json({ success: false, message: "Service not found." });

    const b = req.body, u = { updatedAt: new Date() };
    if (b.name !== undefined)     u.name = String(b.name).trim();
    if (b.platform !== undefined) u.platform = String(b.platform).toLowerCase();
    if (b.enabled !== undefined)  u.enabled = !!b.enabled;
    if (b.min !== undefined)      u.min = parseInt(b.min);
    if (b.max !== undefined)      u.max = parseInt(b.max);
    if (b.markup !== undefined) {
      const m = b.markup === null ? null : parseFloat(b.markup);
      if (m !== null && !(m >= 1)) return res.status(400).json({ success: false, message: "Markup must be 1 or more." });
      u.markup = m;
    }
    await ref.update(u);
    return res.json({ success: true, message: "Service updated." });
  } catch (err) {
    return res.status(500).json({ success: false, message: "Failed to update service." });
  }
};

exports.adminGetOrders = async (req, res) => {
  try {
    let q = getDb().collection("boostOrders");
    if (req.query.status && req.query.status !== "all") q = q.where("status", "==", req.query.status);
    const snap = await q.get();
    const orders = snap.docs
      .map((d) => ({ id: d.id, ...d.data() }))
      .sort((a, b) => toMs(b.createdAt) - toMs(a.createdAt))
      .slice(0, 200);
    return res.json({ success: true, data: { orders } });
  } catch (err) {
    return res.status(500).json({ success: false, message: "Failed to load orders." });
  }
};

// Full refund for an open order (e.g. a needs_review order you confirmed does not exist at Shoprime).
// Card orders are refunded to the user's PromoEarn balance, not back to their card.
exports.adminRefundOrder = async (req, res) => {
  try {
    const snap = await getDb().collection("boostOrders").doc(req.params.id).get();
    if (!snap.exists) return res.status(404).json({ success: false, message: "Order not found." });
    if (snap.data().status === "awaiting_payment") {
      return res.status(400).json({ success: false, message: "This order was never paid, so there is nothing to refund." });
    }
    const r = await refundOrder(req.params.id, {
      amountUsd: snap.data().chargeUsd,
      status: "refunded",
      note: req.body.note || "Refunded by admin.",
    });
    if (!r) return res.status(400).json({ success: false, message: "Order is already settled or refunded." });
    return res.json({ success: true, message: `Refunded $${r.refund.toFixed(2)}.` });
  } catch (err) {
    console.error("Boost adminRefund error:", err);
    return res.status(500).json({ success: false, message: "Refund failed." });
  }
};

// For a needs_review order you found in Shoprime's dashboard: attach its ID so syncing resumes
exports.adminAttachOrder = async (req, res) => {
  try {
    const providerOrderId = String(req.body.providerOrderId || "").trim();
    if (!providerOrderId) return res.status(400).json({ success: false, message: "providerOrderId is required." });
    const ref = getDb().collection("boostOrders").doc(req.params.id);
    const snap = await ref.get();
    if (!snap.exists) return res.status(404).json({ success: false, message: "Order not found." });
    if (snap.data().status !== "needs_review") {
      return res.status(400).json({ success: false, message: "Only needs_review orders can be attached." });
    }
    await ref.update({ providerOrderId, status: "pending", updatedAt: new Date() });
    return res.json({ success: true, message: "Order attached; status sync will resume." });
  } catch (err) {
    return res.status(500).json({ success: false, message: "Failed to attach order." });
  }
};