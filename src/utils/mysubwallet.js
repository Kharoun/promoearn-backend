const axios = require("axios");

const BASE_URL = process.env.MYSUBWALLET_BASE_URL || "https://api.mysubwallet.ng";
const API_KEY  = process.env.MYSUBWALLET_API_KEY;

const client = axios.create({
  baseURL: BASE_URL,
  headers: {
    Authorization: API_KEY,
    "Content-Type": "application/json",
  },
  timeout: 20000,
});

// Unique per-call id so retries never double-charge on mySubwallet's side
const genRequestId = (prefix = "PE") =>
  `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

const logRemote = (label, payload) => {
  try {
    console.log(`[mySubwallet:${label}]`, JSON.stringify(payload, null, 2));
  } catch {
    console.log(`[mySubwallet:${label}]`, payload);
  }
};

// ── Insufficient float detection ────────────────────────────────────────
// Confirmed shape: mySubwallet returns HTTP 403 with
// { status: "fail", message: "Insufficient Account Balance. Kindly Fund
// Your Wallet => ₦24.00" } when their float can't cover the purchase.
// This is distinct from other failures (bad phone number, invalid plan,
// etc), which return different messages/status codes — so we match on
// both the 403 status AND the "insufficient" keyword to avoid false
// positives from an unrelated 403 (e.g. auth issue).
exports.isInsufficientBalanceError = (err) => {
  const status = err.response?.status;
  const message = (err.response?.data?.message || "").toLowerCase();
  return status === 403 && message.includes("insufficient");
};

exports.buyAirtimeRemote = async ({ network, phone, amount, requestId, sandboxFail = false }) => {
  const body = { network, phone, plan_type: "VTU", amount, "request-id": requestId };
  if (sandboxFail) body.sandbox_status = "fail";
  try {
    const { data } = await client.post("/api/topup", body);
    logRemote("buyAirtime SUCCESS body", data);
    return data;
  } catch (err) {
    logRemote("buyAirtime ERROR status", err.response?.status || err.message);
    logRemote("buyAirtime ERROR body", err.response?.data || null);
    throw err;
  }
};

exports.buyDataRemote = async ({ network, phone, dataPlan, requestId, sandboxFail = false }) => {
  const body = { network, phone, data_plan: dataPlan, "request-id": requestId };
  if (sandboxFail) body.sandbox_status = "fail";
  try {
    const { data } = await client.post("/api/data", body);
    logRemote("buyData SUCCESS body", data);
    return data;
  } catch (err) {
    logRemote("buyData ERROR status", err.response?.status || err.message);
    logRemote("buyData ERROR body", err.response?.data || null);
    throw err;
  }
};

exports.getDataPlansRemote = async () => {
  const { data } = await client.get("/api/data-plan");
  return data;
};

exports.getBalanceRemote = async () => {
  const { data } = await client.get("/api/balance");
  return data;
};

exports.requeryRemote = async (reference) => {
  const { data } = await client.get(`/api/requery/${reference}`);
  return data;
};

exports.genRequestId = genRequestId;