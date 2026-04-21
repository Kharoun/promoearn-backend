const twilio = require("twilio");

let client;
let verifyService;

const getClient = () => {
  if (client) return { client, verifyService };

  client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
  verifyService = process.env.TWILIO_VERIFY_SERVICE_SID;

  return { client, verifyService };
};

/**
 * Send OTP to a phone number via Twilio Verify.
 * Twilio handles OTP generation, storage, and expiry automatically.
 *
 * @param {string} phoneNumber - E.164 format e.g. +2348001234567
 * @returns {string} - status ("pending" means sent successfully)
 */
const sendPhoneOtp = async (phoneNumber) => {
  const { client, verifyService } = getClient();

  const verification = await client.verify.v2
    .services(verifyService)
    .verifications.create({
      to: phoneNumber,
      channel: "sms",
    });

  return verification.status; // "pending"
};

/**
 * Check/verify OTP entered by user against Twilio Verify.
 *
 * @param {string} phoneNumber - E.164 format
 * @param {string} code - 6-digit OTP from user
 * @returns {boolean} - true if approved
 */
const verifyPhoneOtp = async (phoneNumber, code) => {
  const { client, verifyService } = getClient();

  const result = await client.verify.v2
    .services(verifyService)
    .verificationChecks.create({
      to: phoneNumber,
      code,
    });

  return result.status === "approved";
};

module.exports = { sendPhoneOtp, verifyPhoneOtp };
