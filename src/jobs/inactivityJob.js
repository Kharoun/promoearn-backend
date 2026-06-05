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
    const db = getDb();
    const snap = await db.collection('users').get();
    const now = Date.now();

    for (const doc of snap.docs) {
      const user = doc.data();
      const uid  = doc.id;

      if (user.isBanned) continue;

      const lastLogin = user.lastLoginAt?._seconds
        ? user.lastLoginAt._seconds * 1000
        : user.lastLoginAt ? new Date(user.lastLoginAt).getTime() : null;

      if (!lastLogin) continue;

      const daysSince = Math.floor((now - lastLogin) / (1000 * 60 * 60 * 24));

      if (daysSince === 5 && !user.inactivityWarningSent) {
        await sendWarningEmail(db, user, uid);
      }

      if (daysSince >= 7) {
        await banUser(db, user, uid);
      }
    }

    console.log('✅ Inactivity check complete.');
  } catch (err) {
    console.error('❌ Inactivity job error:', err);
  }
}

async function sendWarningEmail(db, user, uid) {
  const email     = user.email;
  const firstName = user.firstName || 'User';
  if (!email) return;

  const subject = '⚠️ Action Required: Your PromoEarn account is at risk of suspension';
  const html = `
    <div style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:20px">
      <div style="background:#1A56DB;padding:20px;border-radius:12px 12px 0 0;text-align:center">
        <h2 style="color:#fff;margin:0">PromoEarn</h2>
      </div>
      <div style="background:#fff;padding:28px;border:1px solid #E2E8F0;border-top:none;border-radius:0 0 12px 12px">
        <p style="font-size:15px;color:#0F172A">Hi <strong>${firstName}</strong>,</p>
        <p style="font-size:15px;line-height:1.7;color:#0F172A">
          We noticed you haven't logged into your PromoEarn account in the last 5–6 days.
        </p>
        <p style="font-size:15px;line-height:1.7;color:#0F172A">
          As part of our account activity policy, accounts inactive for <strong>7 consecutive days</strong> 
          are automatically suspended to protect platform integrity.
        </p>
        <div style="background:#FEF3C7;border-left:4px solid #F59E0B;padding:14px;border-radius:0 8px 8px 0;margin:20px 0">
          <p style="margin:0;color:#92400E;font-weight:600;">
            📅 Your account will be suspended in less than 24–48 hours if no action is taken.
          </p>
        </div>
        <a href="https://promoearn.app/login" 
           style="display:inline-block;background:#1A56DB;color:#fff;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:600;margin:10px 0">
          👉 Log In Now to Stay Active
        </a>
        <p style="font-size:13px;color:#64748B;margin-top:20px">
          💳 If suspended, reactivate for a one-time fee of $1 (₦1,500).
        </p>
        <hr style="border:none;border-top:1px solid #E2E8F0;margin:24px 0"/>
        <p style="font-size:12px;color:#94A3B8;text-align:center">
          © ${new Date().getFullYear()} PromoEarn. All rights reserved.
        </p>
      </div>
    </div>
  `;

  try {
    await resend.emails.send({
      from:    'PromoEarn <noreply@promoearnapp.com>',
      to:      email,
      subject,
      html,
    });

    await db.collection('users').doc(uid).update({
      inactivityWarningSent: true,
    });

    await db.collection('adminMessages').add({
      type:           'single',
      subject,
      recipientEmail: email,
      recipientId:    uid,
      sentBy:         'system',
      sentAt:         new Date(),
      trigger:        'inactivity_warning',
    });

    console.log(`📧 Warning sent to ${email}`);
  } catch (err) {
    console.error(`Failed warning email to ${email}:`, err);
  }
}

async function banUser(db, user, uid) {
  const email     = user.email;
  const firstName = user.firstName || 'User';
  if (!email) return;

  const subject = '🚫 Your PromoEarn account has been suspended';
  const html = `
    <div style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:20px">
      <div style="background:#DC2626;padding:20px;border-radius:12px 12px 0 0;text-align:center">
        <h2 style="color:#fff;margin:0">PromoEarn</h2>
      </div>
      <div style="background:#fff;padding:28px;border:1px solid #E2E8F0;border-top:none;border-radius:0 0 12px 12px">
        <p style="font-size:15px;color:#0F172A">Hi <strong>${firstName}</strong>,</p>
        <p style="font-size:15px;line-height:1.7;color:#0F172A">
          Your PromoEarn account has been <strong>automatically suspended</strong> due to 7 days of inactivity.
        </p>
        <div style="background:#FEF2F2;border-left:4px solid #EF4444;padding:14px;border-radius:0 8px 8px 0;margin:20px 0">
          <p style="margin:0;color:#991B1B;font-weight:600;">
            🚫 Your account is now suspended.
          </p>
        </div>
        <p style="font-size:15px;line-height:1.7;color:#0F172A">
          To reactivate your account, pay a one-time fee of <strong>$1 (₦1,500)</strong> 
          and contact our support team.
        </p>
        <a href="mailto:contact.promoearn@gmail.com"
           style="display:inline-block;background:#1A56DB;color:#fff;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:600;margin:10px 0">
          📧 Contact Support
        </a>
        <hr style="border:none;border-top:1px solid #E2E8F0;margin:24px 0"/>
        <p style="font-size:12px;color:#94A3B8;text-align:center">
          © ${new Date().getFullYear()} PromoEarn. All rights reserved.
        </p>
      </div>
    </div>
  `;

  try {
    await db.collection('users').doc(uid).update({
      isBanned:              true,
      bannedAt:              new Date(),
      bannedReason:          'inactivity_7days',
      inactivityWarningSent: false,
    });

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

module.exports = { checkInactiveUsers };