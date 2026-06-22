const { getDb } = require("../config/firebase");

async function sendExpoPush(pushToken, title, body, data = {}) {
  try {
    const response = await fetch("https://exp.host/--/api/v2/push/send", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json",
        "Accept-Encoding": "gzip, deflate",
      },
      body: JSON.stringify({ to: pushToken, sound: "default", title, body, data }),
    });

    const result = await response.json();
    console.log("[Expo Push] response:", JSON.stringify(result));

    const ticket = result?.data;
    if (ticket?.status === "ok") return { ok: true, error: null };

    const reason = ticket?.details?.error || ticket?.message || "Unknown Expo error";
    console.error("[Expo Push] ticket error:", reason, "token:", pushToken);
    return { ok: false, error: reason };
  } catch (err) {
    console.error("[Expo Push] fetch error:", err.message);
    return { ok: false, error: err.message };
  }
}

exports.broadcastPushNotification = async (req, res) => {
  try {
    const { title, body, data = {} } = req.body;
    const db = getDb();

    if (!title || !body) {
      return res.status(400).json({ success: false, message: "Title and body are required." });
    }

    const snap  = await db.collection("users").get();
    const users = snap.docs.map(d => ({ uid: d.id, ...d.data() })).filter(u => u.pushToken);

    if (users.length === 0) {
      return res.status(200).json({
        success: false,
        message: "No registered devices found. Users need to open the app to register their device.",
        data: { sent: 0, failed: 0, total: 0 },
      });
    }

    let sent = 0, failed = 0;
    const BATCH = 20;

    for (let i = 0; i < users.length; i += BATCH) {
      const batch = users.slice(i, i + BATCH);
      const results = await Promise.allSettled(batch.map(u => sendExpoPush(u.pushToken, title, body, data)));
      results.forEach(r => { if (r.status === "fulfilled" && r.value.ok) sent++; else failed++; });
      if (i + BATCH < users.length) await new Promise(r => setTimeout(r, 200));
    }

    await db.collection("adminPushNotifications").add({
      mode: "broadcast", title, body, data,
      recipientCount: users.length, sent, failed,
      sentBy: req.user?.uid || "admin", sentAt: new Date(),
    });

    return res.status(200).json({
      success: sent > 0,
      message: sent > 0
        ? `Sent to ${sent} of ${users.length} devices.${failed > 0 ? ` (${failed} failed — tokens may be expired)` : ""}`
        : `Broadcast attempted but 0 devices received it. All ${failed} tokens appear expired. Users need to reopen the app.`,
      data: { sent, failed, total: users.length },
    });
  } catch (err) {
    console.error("Broadcast push error:", err);
    return res.status(500).json({ success: false, message: "Server error while sending broadcast." });
  }
};

exports.sendSinglePushNotification = async (req, res) => {
  try {
    const { title, body, userId, data = {} } = req.body;
    const db = getDb();

    if (!title || !body || !userId) {
      return res.status(400).json({ success: false, message: "Title, body and userId are required." });
    }

    const userDoc = await db.collection("users").doc(userId).get();
    if (!userDoc.exists) return res.status(404).json({ success: false, message: "User not found." });

    const user = userDoc.data();
    if (!user.pushToken) {
      return res.status(200).json({
        success: false,
        message: "This user has no push token. They need to open the app and grant notification permissions first.",
        data: { sent: 0, failed: 1 },
      });
    }

    const { ok, error } = await sendExpoPush(user.pushToken, title, body, data);

    await db.collection("adminPushNotifications").add({
      mode: "single", title, body, data, userId,
      username: user.username || null,
      recipientEmail: user.email || null,
      sent: ok ? 1 : 0, failed: ok ? 0 : 1,
      expoError: error || null,
      sentBy: req.user?.uid || "admin", sentAt: new Date(),
    });

    if (!ok) {
      return res.status(200).json({
        success: false,
        message: error === "DeviceNotRegistered"
          ? "This user's device token is expired. They need to reopen the app to get a fresh token."
          : `Push delivery failed: ${error || "Token may be expired or invalid."}`,
        data: { sent: 0, failed: 1 },
      });
    }

    return res.status(200).json({
      success: true,
      message: `Push notification sent to ${(user.firstName || "") + " " + (user.lastName || "")}`.trim(),
      data: { sent: 1, failed: 0 },
    });
  } catch (err) {
    console.error("Single push error:", err);
    return res.status(500).json({ success: false, message: "Server error while sending notification." });
  }
};

exports.getPushNotificationHistory = async (req, res) => {
  try {
    const db   = getDb();
    const snap = await db.collection("adminPushNotifications").orderBy("sentAt", "desc").limit(200).get();
    const notifications = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    return res.status(200).json({ success: true, data: { notifications, totalCount: notifications.length } });
  } catch (err) {
    console.error("Push history error:", err);
    return res.status(500).json({ success: false, message: "Failed to fetch history." });
  }
};

exports.getPushNotificationStats = async (req, res) => {
  try {
    const db = getDb();
    const usersSnap = await db.collection("users").get();
    const registeredDevices = usersSnap.docs.filter(d => d.data().pushToken).length;

    const historySnap = await db.collection("adminPushNotifications").get();
    let totalSent = 0, totalBroadcasts = 0, totalSingle = 0;
    historySnap.docs.forEach(d => {
      const item = d.data();
      totalSent += item.sent || 0;
      if (item.mode === "broadcast") totalBroadcasts++; else totalSingle++;
    });

    return res.status(200).json({ success: true, data: { totalSent, registeredDevices, totalBroadcasts, totalSingle } });
  } catch (err) {
    console.error("Push stats error:", err);
    return res.status(500).json({ success: false, message: "Failed to fetch stats." });
  }
};