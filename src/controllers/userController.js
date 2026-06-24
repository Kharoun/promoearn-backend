const { createNotification } = require("./notificationsController");
const { getDb } = require("../config/firebase");

// ─── GET PUBLIC TASKS ─────────────────────────────────────────────────────────
exports.getTasks = async (req, res) => {
  try {
    const db = getDb();
    const snap = await db.collection("tasks")
      .where("status", "==", "active")
      .get();

    const tasks = snap.docs
      .map(doc => ({ id: doc.id, ...doc.data() }))
      .sort((a, b) => b.createdAt?._seconds - a.createdAt?._seconds);

    return res.status(200).json({ success: true, data: { tasks } });
  } catch (err) {
    console.error("Get tasks error:", err);
    return res.status(500).json({ success: false, message: "Failed to fetch tasks." });
  }
};

// ─── COMPLETE TASK ────────────────────────────────────────────────────────────
// ─── SHARED VERSION CHECK HELPER ─────────────────────────────────────────────
const MIN_VERSION = "1.1.0";

const compareVersions = (current, required) => {
  if (!current) return -1;
  const curr = current.split(".").map(Number);
  const req  = required.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if ((curr[i] || 0) > (req[i] || 0)) return 1;
    if ((curr[i] || 0) < (req[i] || 0)) return -1;
  }
  return 0;
};

const requireMinVersion = (req, res) => {
  const appVersion = req.headers["x-app-version"];
  if (compareVersions(appVersion, MIN_VERSION) < 0) {
    res.status(426).json({
      success:         false,
      updateRequired:  true,
      message:         "Please update your app to the latest version to complete tasks.",
      requiredVersion: MIN_VERSION,
      currentVersion:  appVersion || "unknown",
    });
    return false;
  }
  return true;
};

exports.requireMinVersion = requireMinVersion;

// ─── COMPLETE TASK (old endpoint — now fully blocked) ─────────────────────────
exports.completeTask = async (req, res) => {
  try {
    if (!requireMinVersion(req, res)) return;

    // Version is OK but this old endpoint no longer processes rewards.
    // Return 410 Gone — NOT updateRequired, so the app won't show "update" prompt.
    return res.status(410).json({
      success:        false,
      updateRequired: false,
      deprecated:     true,
      message:        "This endpoint is no longer active. Please use the new task submission flow.",
    });

  } catch (err) {
    console.error("Complete task error:", err);
    return res.status(500).json({ success: false, message: "Failed to complete task." });
  }
};
// ─── GET MY REFERRALS ─────────────────────────────────────────────────────────
exports.getMyReferrals = async (req, res) => {
  try {
    const db  = getDb();
    const uid = req.user.uid;

    const snap = await db.collection("users")
      .where("referredBy", "==", uid)
      .get();

    const referrals = snap.docs.map(doc => {
      const data = doc.data();
      return {
        uid:       doc.id,
        username:  data.username,
        firstName: data.firstName,
        lastName:  data.lastName,
        joinedAt:  data.createdAt,
        isActive:  !data.isBanned && data.isActivated,
      };
    });

    // Count referral earnings
    const txSnap = await db.collection("transactions")
      .where("userId", "==", uid)
      .where("type",   "==", "referral")
      .get();

    const referralEarnings = txSnap.docs.reduce((sum, doc) => sum + (doc.data().amount || 0), 0);

    return res.status(200).json({
      success: true,
      data: { referrals, referralEarnings, total: referrals.length },
    });
  } catch (err) {
    console.error("Get referrals error:", err);
    return res.status(500).json({ success: false, message: "Failed to fetch referrals." });
  }
};

// ─── LEADERBOARD ──────────────────────────────────────────────────────────────
exports.getLeaderboard = async (req, res) => {
  try {
    const db = getDb();

    const snap = await db.collection("users")
      .where("isActivated", "==", true)
      .get();

    const leaders = snap.docs
      .map(doc => {
        const data = doc.data();
        return {
          uid:         doc.id,
          username:    data.username,
          firstName:   data.firstName,
          lastName:    data.lastName,
          totalEarned: data.totalEarned || 0,
        };
      })
      .sort((a, b) => b.totalEarned - a.totalEarned)
.slice(0, 15)
.map((u, i) => ({ ...u, rank: i + 1 }));

    return res.status(200).json({ success: true, data: { leaders } });
  } catch (err) {
    console.error("Leaderboard error:", err);
    return res.status(500).json({ success: false, message: "Failed to fetch leaderboard." });
  }
};