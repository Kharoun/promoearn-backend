/**
 * utils/smmProvider.js — Shoprime (standard SMM panel API v2)
 *
 * Env vars (set on Render):
 *   SHOPRIME_API_URL  e.g. https://shoprime.ng/api/v2   (copy the exact URL from Shoprime's API page)
 *   SHOPRIME_API_KEY
 *
 * Every provider call in the app goes through this file, so switching
 * providers later only means changing this file / the env vars.
 */
const axios = require("axios");

class ProviderError extends Error {
  /**
   * definitive = true  → provider clearly refused; order was NOT created (safe to refund)
   * definitive = false → outcome unknown (timeout, network error, garbage response);
   *                      the order MAY exist at the provider → never auto-refund
   */
  constructor(message, definitive) {
    super(message);
    this.name = "ProviderError";
    this.definitive = definitive;
  }
}

const call = async (params) => {
  const url = process.env.SHOPRIME_API_URL;
  const key = process.env.SHOPRIME_API_KEY;
  if (!url || !key) throw new ProviderError("Provider is not configured.", true);

  let data;
  try {
    const res = await axios.post(
      url,
      new URLSearchParams({ key, ...params }).toString(),
      { headers: { "Content-Type": "application/x-www-form-urlencoded" }, timeout: 25000 }
    );
    data = res.data;
  } catch (e) {
    const status = e.response?.status;
    if (status && status >= 400 && status < 500) {
      throw new ProviderError(`Provider rejected the request (HTTP ${status}).`, true);
    }
    throw new ProviderError(e.message || "Network error", false);
  }

  if (typeof data === "string") throw new ProviderError("Unexpected provider response.", false);
  if (data && !Array.isArray(data) && data.error) throw new ProviderError(String(data.error), true);
  return data;
};

const chunk = (arr, size) => {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
};

/** Full service list: [{ service, name, type, category, rate, min, max, refill, cancel }] */
const getServices = async () => {
  const data = await call({ action: "services" });
  if (!Array.isArray(data)) throw new ProviderError("Unexpected services response.", false);
  return data;
};

/** Place an order. Returns the provider's order ID as a string. */
const addOrder = async ({ service, link, quantity }) => {
  const data = await call({
    action: "add",
    service: String(service),
    link,
    quantity: String(quantity),
  });
  if (!data || !data.order) throw new ProviderError("No order ID returned by provider.", false);
  return String(data.order);
};

/**
 * Status for many orders at once.
 * Returns { [providerOrderId]: { status, remains, start_count, charge, currency } | { error } }
 */
const getStatuses = async (ids) => {
  const result = {};
  for (const group of chunk(ids.map(String), 100)) {
    const data = await call({ action: "status", orders: group.join(",") });
    if (group.length === 1 && data && data.status !== undefined) {
      result[group[0]] = data; // some panels return a flat object for a single ID
    } else {
      Object.assign(result, data);
    }
  }
  return result;
};

/** Your balance at the provider: { balance, currency } */
const getBalance = async () => call({ action: "balance" });

module.exports = { getServices, addOrder, getStatuses, getBalance, ProviderError };