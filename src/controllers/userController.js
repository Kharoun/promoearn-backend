const { createNotification } = require("./notificationsController");
const { getDb } = require("../config/firebase");

// ─── GET PUBLIC TASKS ─────────────────────────────────────────────────────────
exports.getTasks = async (req, res) => {
  try {
    const db  = getDb();
    const uid = req.user.uid;

    const [tasksSnap, submissionsSnap, rejectedSnap] = await Promise.all([
      db.collection("tasks").where("status", "==", "active").get(),
      db.collection("taskSubmissions")
        .where("userId", "==", uid)
        .where("status", "in", ["pending", "approved"])
        .get(),
      db.collection("taskSubmissions")
        .where("userId", "==", uid)
        .where("status", "==", "rejected")
        .get(),
    ]);

    const completedTaskIds = submissionsSnap.docs.map(doc => doc.data().taskId);
    const rejectedTaskIds  = rejectedSnap.docs.map(doc => doc.data().taskId);

    const tasks = tasksSnap.docs
      .map(doc => ({ id: doc.id, ...doc.data() }))
      .sort((a, b) => b.createdAt?._seconds - a.createdAt?._seconds);

      return res.status(200).json({
        success: true,
        data: { tasks, completedTaskIds, rejectedTaskIds },  // ← ADD rejectedTaskIds
      });
  } catch (err) {
    console.error("Get tasks error:", err);
    return res.status(500).json({ success: false, message: "Failed to fetch tasks." });
  }
};

// ─── COMPLETE TASK ────────────────────────────────────────────────────────────
// ─── SHARED VERSION CHECK HELPER ─────────────────────────────────────────────


// ─── COMPLETE TASK (old endpoint — now fully blocked) ─────────────────────────
exports.completeTask = async (req, res) => {
  return res.status(410).json({
    success: false,
    deprecated: true,
    message: "This endpoint is no longer active. Please use the new task submission flow.",
  });
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