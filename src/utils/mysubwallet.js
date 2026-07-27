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

// ── TEMP DIAGNOSTIC LOGGER ──────────────────────────────────────────────
// Logs the full raw response (success or failure) so we can see exactly
// what mySubwallet sends back for an insufficient-float failure vs a
// normal failure (bad phone, invalid plan, etc). Remove once we've
// captured real payloads and wired up proper branching logic.
const logRemote = (label, payload) => {
  try {
    console.log(`[mySubwallet:${label}]`, JSON.stringify(payload, null, 2));
  } catch {
    console.log(`[mySubwallet:${label}]`, payload);
  }
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
    throw err; // rethrow — existing requery fallback in vtuController still handles this
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
  logRemote("getBalance body", data);
  return data;
};

exports.requeryRemote = async (reference) => {
  const { data } = await client.get(`/api/requery/${reference}`);
  logRemote("requery body", data);
  return data;
};

exports.genRequestId = genRequestId;