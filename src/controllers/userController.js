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
exports.completeTask = async (req, res) => {
  try {
    const { id } = req.params;
    const db  = getDb();
    const uid = req.user.uid;

    // Check task exists
    const taskDoc = await db.collection("tasks").doc(id).get();
    if (!taskDoc.exists) {
      return res.status(404).json({ success: false, message: "Task not found." });
    }

    const task = taskDoc.data();

    // Check if already completed by user
    const completedSnap = await db.collection("completedTasks")
      .where("userId", "==", uid)
      .where("taskId", "==", id)
      .get();

    if (!completedSnap.empty) {
      return res.status(400).json({ success: false, message: "You have already completed this task." });
    }

    // Check slots
    if (task.slots > 0 && task.filled >= task.slots) {
      return res.status(400).json({ success: false, message: "This task is full." });
    }

    const reward = parseFloat(task.reward) || 0.17;

    // Get user
    const userDoc = await db.collection("users").doc(uid).get();
    const user    = userDoc.data();

    // Update user balance
    await db.collection("users").doc(uid).update({
      balance:        (user.balance        || 0) + reward,
      totalEarned:    (user.totalEarned    || 0) + reward,
      tasksCompleted: (user.tasksCompleted || 0) + 1,
      updatedAt:      new Date(),
    });

    await createNotification(uid, {
      title: "✅ Task Completed!",
      body:  `You earned $${reward.toFixed(2)} for completing "${task.title}"`,
      type:  "taskAlerts",
    });
    
    // Mark task as completed
    await db.collection("completedTasks").add({
      userId:      uid,
      taskId:      id,
      taskTitle:   task.title,
      reward,
      completedAt: new Date(),
    });

    // Update task filled count
    await db.collection("tasks").doc(id).update({
      filled: (task.filled || 0) + 1,
    });

    // Log transaction
    await db.collection("transactions").add({
      userId:      uid,
      type:        "earn",
      description: `Task: ${task.title}`,
      amount:      reward,
      status:      "completed",
      createdAt:   new Date(),
    });

    return res.status(200).json({
      success: true,
      message: `Task completed! +$${reward.toFixed(2)} added to your balance.`,
      data: { reward, newBalance: (user.balance || 0) + reward },
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