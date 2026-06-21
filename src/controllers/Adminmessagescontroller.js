const { getDb }  = require("../config/firebase");
const { Resend }  = require("resend");
const resend      = new Resend(process.env.RESEND_API_KEY);

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * If imageUrl is a base64 data URL (uploaded file), extract the binary content
 * and return it as a Resend inline attachment. The email HTML will reference it
 * via `cid:emailimage` instead of a data: URL — this is the ONLY way Gmail and
 * Outlook will actually render an embedded image from an upload.
 *
 * If imageUrl is an https:// URL, return no attachment and reference the URL
 * directly. Gmail blocks external images by default (user taps "Show images")
 * but it displays once allowed — nothing we can change on our end for that.
 */
function prepareImageForEmail(imageUrl) {
  if (!imageUrl) return { attachment: null, resolvedSrc: null };

  if (imageUrl.startsWith("data:")) {
    const match = imageUrl.match(/^data:([^;]+);base64,(.+)$/s);
    if (!match) return { attachment: null, resolvedSrc: null };

    const mimeType = match[1];          // e.g. "image/jpeg"
    const base64   = match[2];          // raw base64 payload
    const ext      = mimeType.split("/")[1] || "jpg";

    return {
      resolvedSrc: "cid:emailimage",    // referenced inside the HTML
      attachment: {
        filename:   `image.${ext}`,
        content:    base64,             // Resend expects raw base64 string
        content_id: "emailimage",       // must match the cid: above
      },
    };
  }

  // Plain https:// URL — use directly in the img src
  return { resolvedSrc: imageUrl, attachment: null };
}

// ── Email HTML builder ────────────────────────────────────────────────────────
function buildEmailHtml(bodyText, resolvedImageSrc, imagePosition = "top") {
  const escaped = bodyText
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

  const imgBlock = resolvedImageSrc
    ? `<div style="text-align:center;margin:24px 0">
        <img
          src="${resolvedImageSrc}"
          alt="Message image"
          width="560"
          style="max-width:100%;width:100%;border-radius:12px;display:block;margin:0 auto;border:1px solid #E2E8F0"
        />
      </div>`
    : "";

  const topImg    = imagePosition === "top"    ? imgBlock : "";
  const bottomImg = imagePosition === "bottom" ? imgBlock : "";

  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#F8FAFF;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#F8FAFF;padding:32px 16px">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%">
        <tr>
          <td style="background:#0F172A;padding:24px 32px;border-radius:16px 16px 0 0;text-align:center">
            <span style="color:#fff;font-size:22px;font-weight:800;letter-spacing:-0.5px">PromoEarn</span>
          </td>
        </tr>
        <tr>
          <td style="background:#ffffff;padding:36px 32px;border:1px solid #E2E8F0;border-top:none">
            ${topImg}
            <p style="font-size:15px;line-height:1.8;color:#0F172A;margin:0;white-space:pre-line">${escaped}</p>
            ${bottomImg}
          </td>
        </tr>
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

// ── Send to ALL users ─────────────────────────────────────────────────────────
exports.broadcastMessage = async (req, res) => {
  try {
    const { subject, body, imageUrl, imagePosition } = req.body;
    const db = getDb();

    if (!subject || !body) {
      return res.status(400).json({ success: false, message: "Subject and body are required." });
    }

    const { resolvedSrc, attachment } = prepareImageForEmail(imageUrl || null);

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
            const emailPayload = {
              from:    "PromoEarn <noreply@promoearnapp.com>",
              to:      user.email,
              subject,
              html:    buildEmailHtml(personalBody, resolvedSrc, imagePosition || "top"),
            };

            // Attach the image inline (CID) when the admin uploaded a file
            if (attachment) {
              emailPayload.attachments = [attachment];
            }

            const sendResult = await resend.emails.send(emailPayload);

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

    await db.collection("adminMessages").add({
      type:           "broadcast",
      subject,
      body,
      hasImage:       !!resolvedSrc,
      recipientCount: successCount,
      failCount,
      sentBy:         req.user?.uid || "admin",
      sentAt:         new Date(),
    });

    if (successCount === 0) {
      return res.status(200).json({
        success: false,
        message: `Broadcast attempted but 0 emails were delivered. Check server logs. Common causes: (1) Domain not verified in Resend, (2) Invalid RESEND_API_KEY, (3) Rate limit hit.`,
        data: { count: 0, failed: failCount },
      });
    }

    return res.status(200).json({
      success: true,
      message: `Message sent to ${successCount} of ${users.length} users.${failCount > 0 ? ` (${failCount} failed)` : ""}`,
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
    const { subject, body, userId, email, imageUrl, imagePosition } = req.body;
    const db = getDb();

    if (!subject || !body || (!userId && !email)) {
      return res.status(400).json({
        success: false,
        message: "Subject, body and user (userId or email) are required.",
      });
    }

    const { resolvedSrc, attachment } = prepareImageForEmail(imageUrl || null);

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

    const emailPayload = {
      from:    "PromoEarn <noreply@promoearnapp.com>",
      to:      recipientEmail,
      subject,
      html:    buildEmailHtml(personalBody, resolvedSrc, imagePosition || "top"),
    };

    if (attachment) {
      emailPayload.attachments = [attachment];
    }

    const sendResult = await resend.emails.send(emailPayload);

    if (sendResult?.data?.id) {
      console.log(`✅ Single email sent to ${recipientEmail} | Resend ID: ${sendResult.data.id}`);
    } else if (sendResult?.error) {
      console.error(`❌ Resend rejected email to ${recipientEmail}:`, JSON.stringify(sendResult.error));
      return res.status(500).json({
        success: false,
        message: `Resend error: ${sendResult.error.message || JSON.stringify(sendResult.error)}`,
      });
    }

    await db.collection("adminMessages").add({
      type:          "single",
      subject,
      body,
      hasImage:      !!resolvedSrc,
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

    let totalCount = 0;
    try {
      const countSnap = await db.collection("adminMessages").count().get();
      totalCount = countSnap.data().count;
    } catch { /* count() not available on this SDK version */ }

    const snap = await db.collection("adminMessages")
      .orderBy("sentAt", "desc")
      .limit(500)
      .get();

    const messages = snap.docs.map(d => ({ id: d.id, ...d.data() }));
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
