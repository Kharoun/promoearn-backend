const nodemailer = require("nodemailer");

let transporter;

const getTransporter = () => {
  if (transporter) return transporter;

  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT) || 587,
    secure: false, // true for 465, false for 587
    tls: { rejectUnauthorized: false },
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });

  return transporter;
};

// ─── Email Templates ──────────────────────────────────────────────────────────

const verificationEmailTemplate = (otp, name) => `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8" />
  <style>
    body { font-family: 'Segoe UI', sans-serif; background: #F8FAFF; margin: 0; padding: 0; }
    .container { max-width: 520px; margin: 40px auto; background: #fff; border-radius: 20px; overflow: hidden; box-shadow: 0 4px 24px rgba(26,86,219,0.08); }
    .header { background: #1A56DB; padding: 32px; text-align: center; }
    .logo { color: #fff; font-size: 24px; font-weight: 800; letter-spacing: -0.5px; }
    .body { padding: 36px 40px; }
    .greeting { font-size: 18px; font-weight: 700; color: #0F172A; margin-bottom: 8px; }
    .text { font-size: 14px; color: #64748B; line-height: 22px; margin-bottom: 24px; }
    .otp-box { background: #EEF4FF; border: 2px dashed #1A56DB; border-radius: 14px; padding: 24px; text-align: center; margin: 24px 0; }
    .otp { font-size: 40px; font-weight: 800; color: #1A56DB; letter-spacing: 10px; }
    .otp-note { font-size: 12px; color: #94A3B8; margin-top: 8px; }
    .footer { background: #F8FAFF; padding: 20px 40px; text-align: center; font-size: 12px; color: #CBD5E1; border-top: 1px solid #E2E8F0; }
    .warning { background: #FFF5F5; border-left: 3px solid #EF4444; padding: 12px 16px; border-radius: 8px; font-size: 13px; color: #EF4444; margin-top: 16px; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <div class="logo">Promo<span style="color:#93C5FD">Earn</span></div>
    </div>
    <div class="body">
      <div class="greeting">Hi ${name} 👋</div>
      <p class="text">Thanks for signing up! Use the code below to verify your email address. This code expires in <strong>${process.env.OTP_EXPIRY_MINUTES || 10} minutes</strong>.</p>
      <div class="otp-box">
        <div class="otp">${otp}</div>
        <div class="otp-note">Email Verification Code</div>
      </div>
      <div class="warning">⚠️ Never share this code with anyone. PromoEarn will never ask for it.</div>
    </div>
    <div class="footer">© ${new Date().getFullYear()} PromoEarn. All rights reserved.<br/>Your data is safe and encrypted 🔐</div>
  </div>
</body>
</html>
`;

const passwordResetTemplate = (otp, name) => `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8" />
  <style>
    body { font-family: 'Segoe UI', sans-serif; background: #F8FAFF; margin: 0; padding: 0; }
    .container { max-width: 520px; margin: 40px auto; background: #fff; border-radius: 20px; overflow: hidden; box-shadow: 0 4px 24px rgba(26,86,219,0.08); }
    .header { background: #0F172A; padding: 32px; text-align: center; }
    .logo { color: #fff; font-size: 24px; font-weight: 800; }
    .body { padding: 36px 40px; }
    .greeting { font-size: 18px; font-weight: 700; color: #0F172A; margin-bottom: 8px; }
    .text { font-size: 14px; color: #64748B; line-height: 22px; margin-bottom: 24px; }
    .otp-box { background: #FFF7ED; border: 2px dashed #F59E0B; border-radius: 14px; padding: 24px; text-align: center; margin: 24px 0; }
    .otp { font-size: 40px; font-weight: 800; color: #F59E0B; letter-spacing: 10px; }
    .otp-note { font-size: 12px; color: #94A3B8; margin-top: 8px; }
    .footer { background: #F8FAFF; padding: 20px 40px; text-align: center; font-size: 12px; color: #CBD5E1; border-top: 1px solid #E2E8F0; }
    .warning { background: #FFF5F5; border-left: 3px solid #EF4444; padding: 12px 16px; border-radius: 8px; font-size: 13px; color: #EF4444; margin-top: 16px; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <div class="logo">Promo<span style="color:#93C5FD">Earn</span> 🔑</div>
    </div>
    <div class="body">
      <div class="greeting">Password Reset Request</div>
      <p class="text">Hi ${name}, we received a request to reset your password. Use the code below. If you didn't request this, ignore this email.</p>
      <div class="otp-box">
        <div class="otp">${otp}</div>
        <div class="otp-note">Password Reset Code — expires in ${process.env.OTP_EXPIRY_MINUTES || 10} minutes</div>
      </div>
      <div class="warning">⚠️ Never share this code. PromoEarn will never ask for it.</div>
    </div>
    <div class="footer">© ${new Date().getFullYear()} PromoEarn. All rights reserved.</div>
  </div>
</body>
</html>
`;

// ─── Send Functions ───────────────────────────────────────────────────────────

const sendVerificationEmail = async (to, otp, name) => {
  const t = getTransporter();
  await t.sendMail({
    from: `"PromoEarn" <${process.env.EMAIL_FROM}>`,
    to,
    subject: `${otp} — Verify your PromoEarn account`,
    html: verificationEmailTemplate(otp, name),
  });
  console.log(`Verification email sent to ${to}`);
};

const sendPasswordResetEmail = async (to, otp, name) => {
  const t = getTransporter();
  await t.sendMail({
    from: `"PromoEarn" <${process.env.EMAIL_FROM}>`,
    to,
    subject: `${otp} — Reset your PromoEarn password`,
    html: passwordResetTemplate(otp, name),
  });
  console.log(`Password reset email sent to ${to}`);
};

module.exports = { sendVerificationEmail, sendPasswordResetEmail };