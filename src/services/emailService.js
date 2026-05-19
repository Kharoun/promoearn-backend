const { Resend } = require("resend");

const resend = new Resend(process.env.RESEND_API_KEY);

const verificationEmailTemplate = (otp, name) => `
<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"/></head>
<body style="font-family:sans-serif;background:#F8FAFF;margin:0;padding:0">
  <div style="max-width:520px;margin:40px auto;background:#fff;border-radius:20px;overflow:hidden;box-shadow:0 4px 24px rgba(26,86,219,0.08)">
    <div style="background:#1A56DB;padding:32px;text-align:center">
      <h2 style="color:#fff;margin:0">PromoEarn</h2>
    </div>
    <div style="padding:36px 40px">
      <h3 style="color:#0F172A">Hi ${name} 👋</h3>
      <p style="color:#64748B;line-height:1.6">Thanks for signing up! Use the code below to verify your email address. This code expires in <strong>10 minutes</strong>.</p>
      <div style="background:#EEF4FF;border:2px dashed #1A56DB;border-radius:14px;padding:24px;text-align:center;margin:24px 0">
        <div style="font-size:40px;font-weight:800;color:#1A56DB;letter-spacing:10px">${otp}</div>
        <div style="font-size:12px;color:#94A3B8;margin-top:8px">Email Verification Code</div>
      </div>
      <div style="background:#FFF5F5;border-left:3px solid #EF4444;padding:12px 16px;border-radius:8px;font-size:13px;color:#EF4444">
        ⚠️ Never share this code with anyone. PromoEarn will never ask for it.
      </div>
    </div>
    <div style="background:#F8FAFF;padding:20px;text-align:center;font-size:12px;color:#CBD5E1;border-top:1px solid #E2E8F0">
      © ${new Date().getFullYear()} PromoEarn. All rights reserved.
    </div>
  </div>
</body>
</html>`;

const passwordResetTemplate = (otp, name) => `
<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"/></head>
<body style="font-family:sans-serif;background:#F8FAFF;margin:0;padding:0">
  <div style="max-width:520px;margin:40px auto;background:#fff;border-radius:20px;overflow:hidden;box-shadow:0 4px 24px rgba(26,86,219,0.08)">
    <div style="background:#0F172A;padding:32px;text-align:center">
      <h2 style="color:#fff;margin:0">PromoEarn 🔑</h2>
    </div>
    <div style="padding:36px 40px">
      <h3 style="color:#0F172A">Password Reset Request</h3>
      <p style="color:#64748B;line-height:1.6">Hi ${name}, we received a request to reset your password. Use the code below. If you didn't request this, ignore this email.</p>
      <div style="background:#FFF7ED;border:2px dashed #F59E0B;border-radius:14px;padding:24px;text-align:center;margin:24px 0">
        <div style="font-size:40px;font-weight:800;color:#F59E0B;letter-spacing:10px">${otp}</div>
        <div style="font-size:12px;color:#94A3B8;margin-top:8px">Password Reset Code — expires in 10 minutes</div>
      </div>
      <div style="background:#FFF5F5;border-left:3px solid #EF4444;padding:12px 16px;border-radius:8px;font-size:13px;color:#EF4444">
        ⚠️ Never share this code. PromoEarn will never ask for it.
      </div>
    </div>
    <div style="background:#F8FAFF;padding:20px;text-align:center;font-size:12px;color:#CBD5E1;border-top:1px solid #E2E8F0">
      © ${new Date().getFullYear()} PromoEarn. All rights reserved.
    </div>
  </div>
</body>
</html>`;

const sendVerificationEmail = async (to, otp, name) => {
  const { data, error } = await resend.emails.send({
    from: "PromoEarn <noreply@promoearnapp.com>",
    to,
    subject: `${otp} — Verify your PromoEarn account`,
    html: verificationEmailTemplate(otp, name),
  });
  if (error) {
    console.error("Resend verification email failed:", error);
    throw new Error(error.message);
  }
  console.log(`Verification email sent to ${to}`, data?.id);
};

const sendPasswordResetEmail = async (to, otp, name) => {
  const { data, error } = await resend.emails.send({
    from: "PromoEarn <noreply@promoearnapp.com>",
    to,
    subject: `${otp} — Reset your PromoEarn password`,
    html: passwordResetTemplate(otp, name),
  });
  if (error) {
    console.error("Resend password reset email failed:", error);
    throw new Error(error.message);
  }
  console.log(`Password reset email sent to ${to}`, data?.id);
};

module.exports = { sendVerificationEmail, sendPasswordResetEmail };