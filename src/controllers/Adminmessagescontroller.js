const { getDb }       = require("../config/firebase");
const { Resend } = require("resend");
const resend = new Resend(process.env.RESEND_API_KEY);
 
// ── Send to ALL users ─────────────────────────────────────────────────────────
exports.broadcastMessage = async (req, res) => {
  try {
    const { subject, body } = req.body;
    const db = getDb();
 
    if (!subject || !body) {
      return res.status(400).json({ success: false, message: "Subject and body are required." });
    }
 
    // Get all users
    const snap = await db.collection("users").get();
    const users = snap.docs.map(d => ({ uid: d.id, ...d.data() }));
 
    if (users.length === 0) {
      return res.status(400).json({ success: false, message: "No users found." });
    }
 
    // Send emails — batch to avoid rate limits
    let successCount = 0;
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
            await resend.emails.send({
              from:    "PromoEarn <noreply@promoearnapp.com>",
              to:      user.email,
              subject,
              html: `
                <div style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:20px">
                  <div style="background:#1A56DB;padding:20px;border-radius:12px 12px 0 0;text-align:center">
                    <h2 style="color:#fff;margin:0">PromoEarn</h2>
                  </div>
                  <div style="background:#fff;padding:28px;border:1px solid #E2E8F0;border-top:none;border-radius:0 0 12px 12px">
                    <p style="font-size:15px;line-height:1.7;color:#0F172A;white-space:pre-line">${personalBody}</p>
                    <hr style="border:none;border-top:1px solid #E2E8F0;margin:24px 0"/>
                    <p style="font-size:12px;color:#94A3B8;text-align:center">
                      You received this email because you are a PromoEarn member.<br/>
                      © ${new Date().getFullYear()} PromoEarn. All rights reserved.
                    </p>
                  </div>
                </div>
              `,
            });
            console.log(`✅ Sent to ${user.email}`);
            successCount++;
          } catch (emailErr) {
            console.error(`❌ Failed to send to ${user.email}:`, emailErr.message);
          }
        })
      );
      // Small delay between batches to respect rate limits
      if (i + BATCH_SIZE < users.length) {
        await new Promise(r => setTimeout(r, 500));
      }
    }
 
    // Log to Firestore
    await db.collection("adminMessages").add({
      type:           "broadcast",
      subject,
      body,
      recipientCount: successCount,
      sentBy:         req.user?.uid || "admin",
      sentAt:         new Date(),
    });
 
    return res.status(200).json({
      success: true,
      message: `Message sent to ${successCount} users.`,
      data:    { count: successCount },
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
 
    // Get user data for personalization
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
 
      await resend.emails.send({ 
        from: "PromoEarn <noreply@promoearnapp.com>",
        to: recipientEmail,
        subject,
      html: `
        <div style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:20px">
          <div style="background:#1A56DB;padding:20px;border-radius:12px 12px 0 0;text-align:center">
            <h2 style="color:#fff;margin:0">PromoEarn</h2>
          </div>
          <div style="background:#fff;padding:28px;border:1px solid #E2E8F0;border-top:none;border-radius:0 0 12px 12px">
            <p style="font-size:15px;line-height:1.7;color:#0F172A;white-space:pre-line">${personalBody}</p>
            <hr style="border:none;border-top:1px solid #E2E8F0;margin:24px 0"/>
            <p style="font-size:12px;color:#94A3B8;text-align:center">
              © ${new Date().getFullYear()} PromoEarn. All rights reserved.
            </p>
          </div>
        </div>
      `,
    });
 
    // Log to Firestore
    await db.collection("adminMessages").add({
      type:           "single",
      subject,
      body,
      recipientEmail,
      recipientId:    userId || null,
      sentBy:         req.user?.uid || "admin",
      sentAt:         new Date(),
    });
 
    return res.status(200).json({
      success: true,
      message: `Message sent to ${recipientEmail}.`,
      data:    { email: recipientEmail },
    });
 
  } catch (err) {
    console.error("Single message error:", err);
    return res.status(500).json({ success: false, message: "Failed to send message." });
  }
};
 
// ── Get message history ───────────────────────────────────────────────────────
exports.getMessageHistory = async (req, res) => {
  try {
    const db   = getDb();
    const snap = await db.collection("adminMessages")
      .orderBy("sentAt", "desc")
      .limit(50)
      .get();
 
    const messages = snap.docs.map(d => ({ id: d.id, ...d.data() }));
 
    return res.status(200).json({
      success: true,
      data:    { messages },
    });
  } catch (err) {
    console.error("Get history error:", err);
    return res.status(500).json({ success: false, message: "Failed to fetch history." });
  }
};
 
 