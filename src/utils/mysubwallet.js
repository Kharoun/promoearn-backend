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

exports.buyAirtimeRemote = async ({ network, phone, amount, requestId, sandboxFail = false }) => {
  const body = { network, phone, plan_type: "VTU", amount, "request-id": requestId };
  if (sandboxFail) body.sandbox_status = "fail";
  const { data } = await client.post("/api/topup", body);
  return data;
};

exports.buyDataRemote = async ({ network, phone, dataPlan, requestId, sandboxFail = false }) => {
  const body = { network, phone, data_plan: dataPlan, "request-id": requestId };
  if (sandboxFail) body.sandbox_status = "fail";
  const { data } = await client.post("/api/data", body);
  return data;
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