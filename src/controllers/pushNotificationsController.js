/**
 * pushNotificationsController.js
 *
 * DROP THIS FILE into your controllers/ directory and wire up the routes below.
 *
 * Required routes in your admin router (e.g. adminRoutes.js):
 *
 *   const pn = require("./pushNotificationsController");
 *
 *   router.post("/push-notifications/broadcast", authenticate, adminOnly, pn.broadcastPushNotification);
 *   router.post("/push-notifications/single",    authenticate, adminOnly, pn.sendSinglePushNotification);
 *   router.get("/push-notifications/history",    authenticate, adminOnly, pn.getPushNotificationHistory);
 *   router.get("/push-notifications/stats",      authenticate, adminOnly, pn.getPushNotificationStats);
 *
 * Push tokens are read from the "pushToken" field on each user document in Firestore.
 * History is stored in the "adminPushNotifications" Firestore collection.
 */

const { getDb } = require("../config/firebase");

// ─── HELPER: Send one Expo push notification ───────────────────────────────────
async function sendExpoPush(pushToken, title, body, data = {}) {
  try {
    const response = await fetch("https://exp.host/--/api/v2/push/send", {
      method: "POST",
      headers: {
        "Content-Type":  "application/json",
        "Accept":        "application/json",
        "Accept-Encoding": "gzip, deflate",
      },
      body: JSON.stringify({
        to:    pushToken,
        sound: "default",
        title,
        body,
        data,
      }),
    });
    const result = await response.json();
    // Expo returns { data: { status: "ok" } } on success
    return result?.data?.status === "ok";
  } catch (err) {
    console.error("Expo push error:", err.message);
    return false;
  }
}

// ─── BROADCAST to ALL users with a push token ──────────────────────────────────
exports.broadcastPushNotification = async (req, res) => {
  try {
    const { title, body, data = {} } = req.body;
    const db = getDb();

    if (!title || !body) {
      return res.status(400).json({ success: false, message: "Title and body are required." });
    }

    // Fetch all users that have a push token
    const snap  = await db.collection("users").get();
    const users = snap.docs
      .map(d => ({ uid: d.id, ...d.data() }))
      .filter(u => u.pushToken);

    if (users.length === 0) {
      return res.status(200).json({
        success: false,
        message: "No registered devices found.",
        data: { sent: 0, failed: 0 },
      });
    }

    let sent   = 0;
    let failed = 0;
    const BATCH = 20;

    for (let i = 0; i < users.length; i += BATCH) {
      const batch = users.slice(i, i + BATCH);
      const results = await Promise.allSettled(
        batch.map(u => sendExpoPush(u.pushToken, title, body, data))
      );
      results.forEach(r => {
        if (r.status === "fulfilled" && r.value) sent++;
        else failed++;
      });
      // Small delay between batches to avoid Expo rate limits
      if (i + BATCH < users.length) {
        await new Promise(r => setTimeout(r, 200));
      }
    }

    // Save to history
    await db.collection("adminPushNotifications").add({
      mode:           "broadcast",
      title,
      body,
      data,
      recipientCount: users.length,
      sent,
      failed,
      sentBy:         req.user?.uid || "admin",
      sentAt:         new Date(),
    });

    return res.status(200).json({
      success: true,
      message: `Notification sent to ${sent} of ${users.length} devices.${failed > 0 ? ` (${failed} failed)` : ""}`,
      data:    { sent, failed, total: users.length },
    });
  } catch (err) {
    console.error("Broadcast push error:", err);
    return res.status(500).json({ success: false, message: "Failed to send broadcast push." });
  }
};

// ─── SINGLE USER push notification ────────────────────────────────────────────
exports.sendSinglePushNotification = async (req, res) => {
  try {
    const { title, body, userId, data = {} } = req.body;
    const db = getDb();

    if (!title || !body || !userId) {
      return res.status(400).json({ success: false, message: "Title, body and userId are required." });
    }

    const userDoc = await db.collection("users").doc(userId).get();
    if (!userDoc.exists) {
      return res.status(404).json({ success: false, message: "User not found." });
    }

    const user = userDoc.data();
    if (!user.pushToken) {
      return res.status(400).json({
        success: false,
        message: "This user has no registered push token (they may have not opened the app or denied permissions).",
      });
    }

    const ok = await sendExpoPush(user.pushToken, title, body, data);

    // Save to history
    await db.collection("adminPushNotifications").add({
      mode:        "single",
      title,
      body,
      data,
      userId,
      username:    user.username   || null,
      recipientEmail: user.email  || null,
      sent:        ok ? 1 : 0,
      failed:      ok ? 0 : 1,
      sentBy:      req.user?.uid || "admin",
      sentAt:      new Date(),
    });

    if (!ok) {
      return res.status(500).json({
        success: false,
        message: "Push notification failed. The token may be expired or invalid.",
      });
    }

    return res.status(200).json({
      success: true,
      message: `Push notification sent to ${user.firstName || "user"} ${user.lastName || ""}`.trim(),
      data:    { sent: 1, failed: 0 },
    });
  } catch (err) {
    console.error("Single push error:", err);
    return res.status(500).json({ success: false, message: "Failed to send push notification." });
  }
};

// ─── GET HISTORY ───────────────────────────────────────────────────────────────
exports.getPushNotificationHistory = async (req, res) => {
  try {
    const db   = getDb();
    const snap = await db.collection("adminPushNotifications")
      .orderBy("sentAt", "desc")
      .limit(200)
      .get();

    const notifications = snap.docs.map(d => ({ id: d.id, ...d.data() }));

    return res.status(200).json({
      success: true,
      data: { notifications, totalCount: notifications.length },
    });
  } catch (err) {
    console.error("Push history error:", err);
    return res.status(500).json({ success: false, message: "Failed to fetch history." });
  }
};

// ─── GET STATS ─────────────────────────────────────────────────────────────────
exports.getPushNotificationStats = async (req, res) => {
  try {
    const db = getDb();

    // Count users with push tokens
    const usersSnap = await db.collection("users").get();
    const registeredDevices = usersSnap.docs.filter(d => d.data().pushToken).length;

    // Aggregate history stats
    const historySnap = await db.collection("adminPushNotifications").get();
    let totalSent       = 0;
    let totalBroadcasts = 0;
    let totalSingle     = 0;

    historySnap.docs.forEach(d => {
      const item = d.data();
      totalSent += item.sent || 0;
      if (item.mode === "broadcast") totalBroadcasts++;
      else totalSingle++;
    });

    return res.status(200).json({
      success: true,
      data: { totalSent, registeredDevices, totalBroadcasts, totalSingle },
    });
  } catch (err) {
    console.error("Push stats error:", err);
    return res.status(500).json({ success: false, message: "Failed to fetch stats." });
  }
};
