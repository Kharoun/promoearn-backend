const { getDb } = require("../config/firebase");
const { Resend } = require("resend");
const resend = new Resend(process.env.RESEND_API_KEY);
// ─── GET USER NOTIFICATIONS ───────────────────────────────────────────────
exports.getNotifications = async (req, res) => {
  try {
    const db  = getDb();
    const uid = req.user.uid;

    const snap = await db.collection("notifications")
      .where("userId", "==", uid)
      .get();

    const notifications = snap.docs
      .map(doc => ({ id: doc.id, ...doc.data() }))
      .sort((a, b) => b.createdAt?._seconds - a.createdAt?._seconds);

    const unreadCount = notifications.filter(n => !n.read).length;

    return res.status(200).json({
      success: true,
      data: { notifications, unreadCount },
    });
  } catch (err) {
    console.error("Get notifications error:", err);
    return res.status(500).json({ success: false, message: "Failed to fetch notifications." });
  }
};

// ─── MARK ALL AS READ ─────────────────────────────────────────────────────
exports.markAllRead = async (req, res) => {
  try {
    const db  = getDb();
    const uid = req.user.uid;

    const snap = await db.collection("notifications")
      .where("userId", "==", uid)
      .where("read", "==", false)
      .get();

    const batch = db.batch();
    snap.docs.forEach(doc => batch.update(doc.ref, { read: true }));
    await batch.commit();

    return res.status(200).json({ success: true, message: "All notifications marked as read." });
  } catch (err) {
    console.error("Mark read error:", err);
    return res.status(500).json({ success: false, message: "Failed to mark notifications." });
  }
};

// ─── MARK ONE AS READ ────────────────────────────────────────────────────
exports.markOneRead = async (req, res) => {
  try {
    const db  = getDb();
    const { id } = req.params;

    await db.collection("notifications").doc(id).update({ read: true });

    return res.status(200).json({ success: true });
  } catch (err) {
    return res.status(500).json({ success: false, message: "Failed to mark notification." });
  }
};

// ─── SAVE PUSH TOKEN ─────────────────────────────────────────────────────
exports.savePushToken = async (req, res) => {
  try {
    const db    = getDb();
    const uid   = req.user.uid;
    const { pushToken } = req.body;

    await db.collection("users").doc(uid).update({
      pushToken,
      updatedAt: new Date(),
    });

    return res.status(200).json({ success: true, message: "Push token saved." });
  } catch (err) {
    return res.status(500).json({ success: false, message: "Failed to save push token." });
  }
};

// ─── SAVE NOTIFICATION PREFERENCES ───────────────────────────────────────
exports.savePreferences = async (req, res) => {
  try {
    const db  = getDb();
    const uid = req.user.uid;
    const { preferences } = req.body;

    await db.collection("users").doc(uid).update({
      notificationPreferences: preferences,
      updatedAt: new Date(),
    });

    return res.status(200).json({ success: true, message: "Preferences saved." });
  } catch (err) {
    return res.status(500).json({ success: false, message: "Failed to save preferences." });
  }
};

// ─── HELPER: CREATE NOTIFICATION (used internally) ────────────────────────
exports.createNotification = async (userId, { title, body, type, data = {} }) => {
  try {
    const db = getDb();

    // Save to Firestore
    await db.collection("notifications").add({
      userId,
      title,
      body,
      type,
      data,
      read:      false,
      createdAt: new Date(),
    });

    // Send push notification if user has a token
    const userDoc = await db.collection("users").doc(userId).get();
    const user    = userDoc.data();

    if (user?.pushToken && user?.notificationPreferences?.[type] !== false) {
      await sendPushNotification(user.pushToken, title, body, data);
    }
  } catch (err) {
    console.error("Create notification error:", err);
  }
};

// ─── HELPER: SEND EXPO PUSH NOTIFICATION ─────────────────────────────────
const sendPushNotification = async (pushToken, title, body, data = {}) => {
  try {
    await fetch("https://exp.host/--/api/v2/push/send", {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        to:    pushToken,
        sound: "default",
        title,
        body,
        data,
      }),
    });
  } catch (err) {
    console.error("Push notification error:", err);
  }
};

// ─── ADMIN: NOTIFY LOW mySubwallet FLOAT (debounced, email only) ──────────
// Call this every time a VTU order gets queued as pending_topup. It only
// actually emails admins once per "episode" — if an unresolved alert
// already exists, this is a no-op, so many queued orders in a row don't
// spam admins with repeat emails.
exports.notifyAdminsLowVtuBalance = async (db) => {
  try {
    const alertsRef = db.collection("adminAlerts");
    const existing = await alertsRef
      .where("type", "==", "vtuLowBalance")
      .where("resolved", "==", false)
      .limit(1)
      .get();

    if (!existing.empty) return; // already alerted — don't spam

    await alertsRef.add({
      type: "vtuLowBalance",
      resolved: false,
      createdAt: new Date(),
    });

    const adminsSnap = await db.collection("users").where("isAdmin", "==", true).get();
    const adminEmails = adminsSnap.docs
      .map((doc) => doc.data().email)
      .filter(Boolean);

    if (adminEmails.length === 0) {
      console.warn("notifyAdminsLowVtuBalance: no admin emails found to notify.");
      return;
    }

    await Promise.all(
      adminEmails.map((email) =>
        resend.emails.send({
          from: "PromoEarn <noreply@promoearnapp.com>",
          to: email,
          subject: "⚠️ mySubwallet Balance Low — PromoEarn Admin",
          html: `
            <div style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:20px">
              <div style="background:#DC2626;padding:20px;border-radius:12px 12px 0 0;text-align:center">
                <h2 style="color:#fff;margin:0">PromoEarn Admin</h2>
              </div>
              <div style="background:#fff;padding:24px;border:1px solid #E2E8F0;border-top:none;border-radius:0 0 12px 12px">
                <p style="font-size:15px;color:#0F172A;font-weight:700;">mySubwallet Balance Low</p>
                <p style="font-size:14px;color:#374151;line-height:1.7;">
                  One or more VTU (airtime/data) orders are queued because your mySubwallet float ran out.
                  Users have already been charged and are waiting — top up your mySubwallet balance and
                  process the pending queue to deliver these orders.
                </p>
                <div style="text-align:center;margin:24px 0;">
                  <a href="https://promo-earn-admin.vercel.app"
                     style="display:inline-block;background:#1E40AF;color:#fff;padding:14px 32px;border-radius:10px;text-decoration:none;font-weight:700;font-size:15px;">
                    👉 Open Admin Panel
                  </a>
                </div>
                <p style="font-size:12px;color:#94A3B8;margin-top:16px;">
                  You won't receive another alert for this issue until it's resolved, to avoid inbox spam.
                </p>
              </div>
            </div>
          `,
        }).catch((err) => console.error(`Failed to email admin alert to ${email}:`, err.message))
      )
    );
  } catch (err) {
    console.error("notifyAdminsLowVtuBalance error:", err);
  }
};

// ─── ADMIN: CLEAR THE LOW-BALANCE ALERT ───────────────────────────────────
// Call this once the pending queue is fully drained (from the retry job
// or the manual "process now" trigger), so the next low-balance episode
// raises a fresh alert instead of staying silenced forever.
exports.markVtuLowBalanceResolved = async (db) => {
  try {
    const alertsRef = db.collection("adminAlerts");
    const snap = await alertsRef
      .where("type", "==", "vtuLowBalance")
      .where("resolved", "==", false)
      .get();

    await Promise.all(
      snap.docs.map((doc) => doc.ref.update({ resolved: true, resolvedAt: new Date() }))
    );
  } catch (err) {
    console.error("markVtuLowBalanceResolved error:", err);
  }
};