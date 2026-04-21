const { getDb } = require("../config/firebase");

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