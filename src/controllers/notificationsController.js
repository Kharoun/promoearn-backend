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

// ─── ADMIN: NOTIFY LOW mySubwallet FLOAT (debounced) ──────────────────────
// Call this every time a VTU order gets queued as pending_topup. It only
// actually notifies admins once per "episode" — if an unresolved alert
// already exists, this is a no-op, so many queued orders in a row don't
// spam admins with repeat notifications.
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

    await Promise.all(
      adminsSnap.docs.map((doc) =>
        exports.createNotification(doc.id, {
          title: "⚠️ mySubwallet Balance Low",
          body: "One or more VTU orders are queued because mySubwallet float ran out. Top up to release them.",
          type: "adminAlert",
        })
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