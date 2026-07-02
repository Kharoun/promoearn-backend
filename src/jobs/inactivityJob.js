const cron = require('node-cron');
const { getDb } = require('../config/firebase');
const { Resend } = require('resend');
const resend = new Resend(process.env.RESEND_API_KEY);

// Runs every day at midnight
cron.schedule('0 0 * * *', async () => {
  console.log('⏰ Running inactivity check...');
  await checkInactiveUsers();
});

async function checkInactiveUsers() {
  try {
    const db  = getDb();
    const snap = await db.collection('users').get();
    const now  = Date.now();

    for (const doc of snap.docs) {
      const user = doc.data();
      const uid  = doc.id;

      if (user.isBanned) continue;

      const lastLogin = user.lastLoginAt?._seconds
        ? user.lastLoginAt._seconds * 1000
        : user.lastLoginAt ? new Date(user.lastLoginAt).getTime() : null;

      if (!lastLogin) continue;

      const daysSince = Math.floor((now - lastLogin) / (1000 * 60 * 60 * 24));

      // At 10 days: warn + ban
      if (daysSince >= 10 && !user.bannedReason) {
        await banAndNotifyUser(db, user, uid);
      }
    }

    console.log('✅ Inactivity check complete.');
  } catch (err) {
    console.error('❌ Inactivity job error:', err);
  }
}

async function banAndNotifyUser(db, user, uid) {
  const email     = user.email;
  const firstName = user.firstName || 'User';
  if (!email) return;

  // Prevent duplicate bans
  if (user.bannedReason === 'inactivity_10days') return;

  const crypto    = require('crypto');
  const token     = crypto.randomBytes(32).toString('hex');
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  const expiry    = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days

  const reactivationLink = `https://promoearnapp.com/reactivate.html?token=${token}&email=${encodeURIComponent(email)}`;

  const subject = '🚫 Your PromoEarn account has been suspended due to inactivity';
  const html = buildBanEmail(firstName, reactivationLink);

  try {
    // Ban first
    await db.collection('users').doc(uid).update({
      isBanned:                true,
      bannedAt:                new Date(),
      bannedReason:            'inactivity_10days',
      inactivityWarningSent:   true,
      reactivationToken:       tokenHash,
      reactivationTokenExpiry: expiry,
    });

    // Then email
    await resend.emails.send({
      from:    'PromoEarn <noreply@promoearnapp.com>',
      to:      email,
      subject,
      html,
    });

    await db.collection('adminMessages').add({
      type:           'single',
      subject,
      recipientEmail: email,
      recipientId:    uid,
      sentBy:         'system',
      sentAt:         new Date(),
      trigger:        'inactivity_ban',
    });

    console.log(`🚫 Banned and emailed: ${email}`);
  } catch (err) {
    console.error(`Failed ban process for ${email}:`, err);
  }
}

function buildBanEmail(firstName, reactivationLink) {
  return `
    <div style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:20px">
      <div style="background:#DC2626;padding:20px;border-radius:12px 12px 0 0;text-align:center">
        <h2 style="color:#fff;margin:0">PromoEarn</h2>
      </div>
      <div style="background:#fff;padding:28px;border:1px solid #E2E8F0;border-top:none;border-radius:0 0 12px 12px">
        <p style="font-size:15px;color:#0F172A">Hi <strong>${firstName}</strong>,</p>
        <p style="font-size:15px;line-height:1.7;color:#0F172A">
          Your PromoEarn account has been <strong>automatically suspended</strong> due to 10 days of inactivity.
        </p>
        <div style="background:#FEF2F2;border-left:4px solid #EF4444;padding:14px;border-radius:0 8px 8px 0;margin:20px 0">
          <p style="margin:0;color:#991B1B;font-weight:600;">🚫 Your account is now suspended.</p>
        </div>

        <h3 style="color:#0F172A;margin-top:24px;font-size:16px;">How to Reactivate Your Account</h3>
               <p style="font-size:15px;line-height:1.7;color:#0F172A">
          To reactivate, transfer <strong>₦1,000</strong> to our account below, then click the button to submit your request. Your account will be restored within 24 hours.
        </p>
        <div style="background:#EEF4FF;border:1px solid #C7D7FA;border-radius:10px;padding:16px;margin:16px 0;font-size:14px;color:#0F172A;">
          <p style="margin:0 0 6px;font-weight:700;">Transfer ₦1,000 to:</p>
          <p style="margin:0;line-height:1.8;">
            <strong>Bank:</strong> Sterling Bank <br/>
            <strong>Account Number:</strong> 0144524670 <br/>
            <strong>Account Name:</strong>PROMO EARN DIGITAL HUB
          </p>
        </div>

        <div style="background:#F0FDF4;border:1px solid #86EFAC;border-radius:10px;padding:16px;margin:20px 0">
          <p style="margin:0 0 8px;font-weight:700;color:#166534;">After payment:</p>
          <ul style="margin:0;padding-left:20px;color:#166534;line-height:1.8;font-size:14px;">
            <li>Your account is instantly unbanned ✅</li>
            <li>All your earnings and progress are restored 💰</li>
            <li>You can start completing tasks again immediately 🎯</li>
          </ul>
        </div>

        <div style="text-align:center;margin:28px 0;">
          <a href="${reactivationLink}"
             style="display:inline-block;background:#16A34A;color:#fff;padding:16px 36px;border-radius:10px;text-decoration:none;font-weight:700;font-size:16px;">
                        👉 Submit Reactivation Request
          </a>
        </div>

        <p style="font-size:13px;color:#64748B;text-align:center;">
          This link expires in <strong>7 days</strong>.<br/>
          Questions? Contact us at 
          <a href="mailto:contact.promoearn@gmail.com" style="color:#1A56DB;">contact.promoearn@gmail.com</a>
        </p>

        <hr style="border:none;border-top:1px solid #E2E8F0;margin:24px 0"/>
        <p style="font-size:12px;color:#94A3B8;text-align:center">
          © ${new Date().getFullYear()} PromoEarn. All rights reserved.
        </p>
      </div>
    </div>
  `;
}

module.exports = { checkInactiveUsers, banAndNotifyUser, buildBanEmail };
