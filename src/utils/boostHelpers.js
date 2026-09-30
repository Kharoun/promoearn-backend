/**
 * utils/boostHelpers.js — config, pricing, link validation, atomic refunds
 */
const { getDb } = require("../config/firebase");
const { createNotification } = require("../controllers/notificationsController");

const NGN_RATE = 1500; // same rate used across PromoEarn

// Stored in Firestore at config/boost. Missing doc => Boost is OFF (kill switch).
const BOOST_CONFIG_DEFAULTS = {
  boostEnabled:     false,
  maxOrderUsd:      10,     // per-order cap while testing
  defaultMarkup:    1.6,    // 60% over provider cost
  maxOrdersPerHour: 10,     // per user
  providerCurrency: "NGN",  // currency Shoprime quotes rates in: "NGN" or "USD"
};

const OPEN_STATUSES = ["submitting", "pending", "in_progress", "needs_review"];

const round4 = (n) => Math.round(n * 10000) / 10000;

const toMs = (d) =>
  d?.toMillis ? d.toMillis() : d?._seconds ? d._seconds * 1000 : d ? new Date(d).getTime() : 0;

const getBoostConfig = async () => {
  const snap = await getDb().collection("config").doc("boost").get();
  return { ...BOOST_CONFIG_DEFAULTS, ...(snap.exists ? snap.data() : {}) };
};

// ── Pricing ──────────────────────────────────────────────────────────────
const toUsd = (amount, currency) =>
  String(currency).toUpperCase() === "USD" ? amount : amount / NGN_RATE;

const markupOf = (svc, cfg) => (svc.markup && svc.markup >= 1 ? svc.markup : cfg.defaultMarkup);

/** Price per 1,000 shown to users (USD). */
const userRatePer1000Usd = (svc, cfg) =>
  round4(toUsd(svc.providerRatePer1000, cfg.providerCurrency) * markupOf(svc, cfg));

/** Server-side price for an order. Never trust a price sent from the app. */
const calcCharge = (svc, qty, cfg) => {
  const costUsd = toUsd((svc.providerRatePer1000 * qty) / 1000, cfg.providerCurrency);
  const raw = round4(costUsd * markupOf(svc, cfg));
  const chargeUsd = Math.max(0.01, Math.ceil(raw * 100 - 1e-6) / 100); // round UP to the cent
  return { costUsd: round4(costUsd), chargeUsd };
};

// ── Links ────────────────────────────────────────────────────────────────
const PLATFORM_HOSTS = {
  instagram: ["instagram.com"],
  tiktok:    ["tiktok.com"],
  youtube:   ["youtube.com", "youtu.be"],
  facebook:  ["facebook.com", "fb.com", "fb.watch"],
  twitter:   ["twitter.com", "x.com"],
  telegram:  ["t.me", "telegram.me"],
  spotify:   ["spotify.com"],
};

const PLATFORM_PATTERNS = [
  ["instagram", /instagram|\big\b/],
  ["tiktok",    /tiktok/],
  ["youtube",   /youtube|\byt\b/],
  ["facebook",  /facebook|\bfb\b/],
  ["twitter",   /twitter|\bx\b|tweet/],
  ["telegram",  /telegram/],
  ["spotify",   /spotify/],
];

const guessPlatform = (text = "") => {
  const t = String(text).toLowerCase();
  const hit = PLATFORM_PATTERNS.find(([, re]) => re.test(t));
  return hit ? hit[0] : "other";
};

/** Returns a cleaned https URL, or null if invalid / wrong platform. */
const validateLink = (link, platform) => {
  let u;
  try { u = new URL(String(link).trim()); } catch { return null; }
  if (u.protocol !== "https:") return null;
  const hosts = PLATFORM_HOSTS[platform];
  if (hosts) {
    const h = u.hostname.toLowerCase();
    if (!hosts.some((x) => h === x || h.endsWith("." + x))) return null;
  }
  return u.toString();
};

// ── Atomic refund (safe against double refunds) ──────────────────────────
/**
 * Refunds `amountUsd` to the order's owner and closes the order with `status`
 * ("failed" | "canceled" | "partial" | "refunded"). Does nothing if the order
 * was already refunded or is no longer open. Returns { refund, userId } or null.
 */
const refundOrder = async (orderId, { amountUsd, status, note = "" }) => {
  const db = getDb();
  const orderRef = db.collection("boostOrders").doc(orderId);
  let result = null;

  await db.runTransaction(async (t) => {
    const oSnap = await t.get(orderRef);
    if (!oSnap.exists) return;
    const o = oSnap.data();
    if (o.refundedUsd > 0 || !OPEN_STATUSES.includes(o.status)) return;

    const refund = Math.min(round4(amountUsd), o.chargeUsd);
    const userRef = db.collection("users").doc(o.userId);
    const uSnap = await t.get(userRef);
    if (!uSnap.exists) return;

    // all reads are done — writes below
    t.update(userRef, { balance: round4((uSnap.data().balance || 0) + refund), updatedAt: new Date() });
    t.update(orderRef, { status, refundedUsd: refund, note, updatedAt: new Date(), finishedAt: new Date() });
    t.set(db.collection("transactions").doc(), {
      userId: o.userId,
      type: "refund",
      description: `Boost refund: ${o.serviceName} (${status})`,
      amount: refund,
      status: "completed",
      orderId,
      createdAt: new Date(),
    });
    result = { refund, userId: o.userId, serviceName: o.serviceName };
  });

  if (result) {
    await createNotification(result.userId, {
      title: status === "partial" ? "⚠️ Boost Partially Delivered" : "↩️ Boost Order Refunded",
      body: `$${result.refund.toFixed(2)} for your ${result.serviceName} order was returned to your balance.`,
      type: "paymentAlerts",
    }).catch(() => {});
  }
  return result;
};

module.exports = {
  NGN_RATE, BOOST_CONFIG_DEFAULTS, OPEN_STATUSES,
  round4, toMs, getBoostConfig, toUsd,
  userRatePer1000Usd, calcCharge,
  guessPlatform, validateLink, refundOrder,
};