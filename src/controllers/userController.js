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

// ─── Helper: start of current week (Monday 00:00 UTC) ────────────────────
const getWeekStart = () => {
  const now = new Date();
  const day = now.getUTCDay(); // 0=Sun..6=Sat
  const diff = day === 0 ? 6 : day - 1;
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - diff, 0, 0, 0));
};

// ─── LEADERBOARD (resets weekly) ──────────────────────────────────────────
exports.getLeaderboard = async (req, res) => {
  try {
    const db = getDb();
    const weekStart = getWeekStart();

    const [usersSnap, txSnap] = await Promise.all([
      db.collection("users").where("isActivated", "==", true).get(),
      db.collection("transactions").where("createdAt", ">=", weekStart).get(),
    ]);

    const weeklyTotals = {};
    txSnap.docs.forEach((doc) => {
      const d = doc.data();
      if (d.amount > 0 && d.userId) {
        weeklyTotals[d.userId] = (weeklyTotals[d.userId] || 0) + d.amount;
      }
    });

    const leaders = usersSnap.docs
      .map((doc) => {
        const data = doc.data();
        return {
          uid: doc.id,
          username: data.username,
          firstName: data.firstName,
          lastName: data.lastName,
          totalEarned: weeklyTotals[doc.id] || 0,
        };
      })
      .filter((u) => u.totalEarned > 0)
      .sort((a, b) => b.totalEarned - a.totalEarned)
      .slice(0, 15)
      .map((u, i) => ({ ...u, rank: i + 1 }));

    return res.status(200).json({ success: true, data: { leaders, weekStart } });
  } catch (err) {
    console.error("Leaderboard error:", err);
    return res.status(500).json({ success: false, message: "Failed to fetch leaderboard." });
  }
};
// ─── ACTIVITY HISTORY (tasks + transactions + campaigns + last login) ────
exports.getActivityHistory = async (req, res) => {
  try {
    const db  = getDb();
    const uid = req.user.uid;

    const [subsSnap, txSnap, campSnap, userDoc] = await Promise.all([
      db.collection("taskSubmissions").where("userId", "==", uid).orderBy("submittedAt", "desc").limit(30).get(),
      db.collection("transactions").where("userId", "==", uid).orderBy("createdAt", "desc").limit(30).get(),
      db.collection("campaigns").where("submittedBy", "==", uid).orderBy("createdAt", "desc").limit(30).get(),
      db.collection("users").doc(uid).get(),
    ]);

    const items = [];

    subsSnap.docs.forEach((doc) => {
      const d = doc.data();
      items.push({
        id: doc.id,
        category: "task",
        title: d.taskTitle || "Task submitted",
        subtitle: `Status: ${d.status}`,
        amount: d.taskReward || 0,
        status: d.status,
        date: d.submittedAt,
      });
    });

    txSnap.docs.forEach((doc) => {
      const d = doc.data();
      items.push({
        id: doc.id,
        category: "transaction",
        title: d.description || d.type || "Transaction",
        subtitle: d.type || "",
        amount: d.amount || 0,
        status: d.status || null,
        date: d.createdAt,
      });
    });

    campSnap.docs.forEach((doc) => {
      const d = doc.data();
      items.push({
        id: doc.id,
        category: "campaign",
        title: d.brandName || "Campaign",
        subtitle: `Status: ${d.status}`,
        amount: d.quotedTotal || 0,
        status: d.status,
        date: d.createdAt,
      });
    });

    if (userDoc.exists) {
      const u = userDoc.data();
      if (u.lastLoginAt) {
        items.push({
          id: "last-login",
          category: "session",
          title: "Login session",
          subtitle: "You signed in",
          amount: null,
          status: null,
          date: u.lastLoginAt,
        });
      }
    }

    const toMillis = (d) =>
      d?._seconds ? d._seconds * 1000 : d?.toMillis ? d.toMillis() : d ? new Date(d).getTime() : 0;
    items.sort((a, b) => toMillis(b.date) - toMillis(a.date));

    return res.status(200).json({ success: true, data: { items } });
  } catch (err) {
    console.error("Activity history error:", err);
    return res.status(500).json({ success: false, message: "Failed to fetch activity history." });
  }
};