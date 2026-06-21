const { getDb }  = require("../config/firebase");
const { Resend }  = require("resend");
const resend      = new Resend(process.env.RESEND_API_KEY);

// ── Send to ALL users ─────────────────────────────────────────────────────────
exports.broadcastMessage = async (req, res) => {
  try {
    const { subject, body } = req.body;
    const db = getDb();

    if (!subject || !body) {
      return res.status(400).json({ success: false, message: "Subject and body are required." });
    }

    const snap  = await db.collection("users").get();
    const users = snap.docs.map(d => ({ uid: d.id, ...d.data() }));

    if (users.length === 0) {
      return res.status(400).json({ success: false, message: "No users found." });
    }

    let successCount = 0;
    let failCount    = 0;
    const BATCH_SIZE = 10;

    for (let i = 0; i < users.length; i += BATCH_SIZE) {
      const batch = users.slice(i, i + BATCH_SIZE);

      await Promise.allSettled(
        batch.map(async (user) => {
          if (!user.email) return;

          const personalBody = body
            .replace(/{firstName}/g, user.firstName || "User")
            .replace(/{lastName}/g,  user.lastName  || "")
            .replace(/{username}/g,  user.username  || "");

          try {
            const sendResult = await resend.emails.send({
              from:    "PromoEarn <noreply@promoearnapp.com>",
              to:      user.email,
              subject,
              html: buildEmailHtml(personalBody),
            });

            // ── Log the Resend ID so you can verify delivery in Resend dashboard ──
            // Go to https://resend.com/emails and search this ID to confirm delivery.
            // If you see the ID there but the user didn't receive it → check their spam.
            // If you DON'T see the ID → your domain is not verified (test mode).
            if (sendResult?.data?.id) {
              console.log(`✅ Sent to ${user.email} | Resend ID: ${sendResult.data.id}`);
              successCount++;
            } else if (sendResult?.error) {
              console.error(`❌ Resend rejected ${user.email}:`, JSON.stringify(sendResult.error));
              failCount++;
            } else {
              console.warn(`⚠️  Unexpected Resend response for ${user.email}:`, JSON.stringify(sendResult));
              failCount++;
            }
          } catch (emailErr) {
            console.error(`❌ Exception sending to ${user.email}:`, emailErr.message);
            failCount++;
          }
        })
      );

      if (i + BATCH_SIZE < users.length) {
        await new Promise(r => setTimeout(r, 500));
      }
    }

    console.log(`📊 Broadcast complete — success: ${successCount}, failed: ${failCount}`);

    // Log to Firestore
    await db.collection("adminMessages").add({
      type:           "broadcast",
      subject,
      body,
      recipientCount: successCount,
      failCount,
      sentBy:         req.user?.uid || "admin",
      sentAt:         new Date(),
    });

    // ── FIX: return a clear message even if successCount is 0 ──
    if (successCount === 0) {
      return res.status(200).json({
        success: false,
        message: `Broadcast attempted but 0 emails were delivered. Check server logs for Resend errors. Common causes: (1) Domain not verified in Resend dashboard, (2) Invalid RESEND_API_KEY, (3) Resend rate limit hit.`,
        data: { count: 0, failed: failCount },
      });
    }

    return res.status(200).json({
      success: true,
      message: `Message sent to ${successCount} of ${users.length} users.${failCount > 0 ? ` (${failCount} failed — check server logs)` : ""}`,
      data:    { count: successCount, failed: failCount },
    });

  } catch (err) {
    console.error("Broadcast error:", err);
    return res.status(500).json({ success: false, message: "Failed to send broadcast." });
  }
};

// ── Send to SINGLE user ───────────────────────────────────────────────────────
exports.sendSingleMessage = async (req, res) => {
  try {
    const { subject, body, userId, email } = req.body;
    const db = getDb();

    if (!subject || !body || (!userId && !email)) {
      return res.status(400).json({
        success: false,
        message: "Subject, body and user (userId or email) are required.",
      });
    }

    let user = null;
    if (userId) {
      const userDoc = await db.collection("users").doc(userId).get();
      if (userDoc.exists) user = { uid: userDoc.id, ...userDoc.data() };
    }

    const recipientEmail = email || user?.email;
    if (!recipientEmail) {
      return res.status(400).json({ success: false, message: "Could not find user email." });
    }

    const personalBody = body
      .replace(/{firstName}/g, user?.firstName || "User")
      .replace(/{lastName}/g,  user?.lastName  || "")
      .replace(/{username}/g,  user?.username  || "");

    const sendResult = await resend.emails.send({
      from:    "PromoEarn <noreply@promoearnapp.com>",
      to:      recipientEmail,
      subject,
      html:    buildEmailHtml(personalBody),
    });

    // ── Log Resend ID — verify in https://resend.com/emails ──
    if (sendResult?.data?.id) {
      console.log(`✅ Single email sent to ${recipientEmail} | Resend ID: ${sendResult.data.id}`);
    } else if (sendResult?.error) {
      console.error(`❌ Resend rejected single email to ${recipientEmail}:`, JSON.stringify(sendResult.error));
      return res.status(500).json({
        success: false,
        message: `Resend error: ${sendResult.error.message || JSON.stringify(sendResult.error)}`,
      });
    }

    // Log to Firestore
    await db.collection("adminMessages").add({
      type:          "single",
      subject,
      body,
      recipientEmail,
      recipientId:   userId || null,
      resendId:      sendResult?.data?.id || null,
      sentBy:        req.user?.uid || "admin",
      sentAt:        new Date(),
    });

    return res.status(200).json({
      success: true,
      message: `Message sent to ${recipientEmail}.`,
      data:    { email: recipientEmail, resendId: sendResult?.data?.id },
    });

  } catch (err) {
    console.error("Single message error:", err.message, err.response?.data || "");
    return res.status(500).json({ success: false, message: `Failed to send message: ${err.message}` });
  }
};

// ── Get message history ───────────────────────────────────────────────────────
exports.getMessageHistory = async (req, res) => {
  try {
    const db = getDb();

    // ── FIX 1: Get the real total count (not limited) ──
    // Firebase Admin SDK v11+ supports count() aggregation.
    // If this throws, fall back to counting the fetched docs.
    let totalCount = 0;
    try {
      const countSnap = await db.collection("adminMessages").count().get();
      totalCount = countSnap.data().count;
    } catch {
      // count() not supported on this SDK version — will set from fetched docs below
    }

    // ── FIX 2: Increase limit from 50 → 500 for the history list ──
    const snap = await db.collection("adminMessages")
      .orderBy("sentAt", "desc")
      .limit(500)
      .get();

    const messages = snap.docs.map(d => ({ id: d.id, ...d.data() }));

    // Fallback: if count() isn't supported, totalCount = messages in Firestore
    // (accurate up to 500; add a counter document if you need exact counts beyond that)
    if (totalCount === 0) totalCount = messages.length;

    return res.status(200).json({
      success: true,
      data:    { messages, totalCount },
    });
  } catch (err) {
    console.error("Get history error:", err);
    return res.status(500).json({ success: false, message: "Failed to fetch history." });
  }
};

// ── Shared HTML email template ────────────────────────────────────────────────
function buildEmailHtml(bodyText) {
  // Escape HTML special chars in the body to prevent injection / broken layouts
  const escaped = bodyText
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#F8FAFF;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#F8FAFF;padding:32px 16px">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%">
        <!-- Header -->
        <tr>
          <td style="background:#0F172A;padding:24px 32px;border-radius:16px 16px 0 0;text-align:center">
            <span style="color:#fff;font-size:22px;font-weight:800;letter-spacing:-0.5px">PromoEarn</span>
          </td>
        </tr>
        <!-- Body -->
        <tr>
          <td style="background:#ffffff;padding:36px 32px;border:1px solid #E2E8F0;border-top:none">
            <p style="font-size:15px;line-height:1.8;color:#0F172A;margin:0;white-space:pre-line">${escaped}</p>
          </td>
        </tr>
        <!-- Footer -->
        <tr>
          <td style="background:#F8FAFF;border:1px solid #E2E8F0;border-top:none;border-radius:0 0 16px 16px;padding:20px 32px;text-align:center">
            <p style="font-size:12px;color:#94A3B8;margin:0">
              You received this because you are a PromoEarn member.<br/>
              &copy; ${new Date().getFullYear()} PromoEarn. All rights reserved.
            </p>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}
