const { getDb } = require("../config/firebase");

const sanitizeUser = (uid, data) => {
  const { passwordHash, ...safe } = data;
  return { uid, ...safe };
};

// ─── DASHBOARD ────────────────────────────────────────────────────────────────

exports.getDashboard = async (req, res) => {
  try {
    const db = getDb();

    const [usersSnap, tasksSnap, paymentsSnap, referralsSnap] = await Promise.all([
      db.collection("users").get(),
      db.collection("tasks").get(),
      db.collection("payments").where("status", "==", "pending").get(),
      db.collection("referrals").get(),
    ]);

    // Total earned across all users
    let totalEarned = 0;
    usersSnap.forEach(doc => {
      totalEarned += doc.data().balance || 0;
    });

    // Recent users — last 5
    const recentUsers = usersSnap.docs
      .map(doc => sanitizeUser(doc.id, doc.data()))
      .sort((a, b) => b.createdAt?._seconds - a.createdAt?._seconds)
      .slice(0, 5);

    return res.status(200).json({
      success: true,
      data: {
        stats: {
          totalUsers: usersSnap.size,
          totalEarned: totalEarned.toFixed(2),
          pendingWithdrawals: paymentsSnap.size,
          activeTasks: tasksSnap.size,
          totalReferrals: referralsSnap.size,
        },
        recentUsers,
      },
    });
  } catch (err) {
    console.error("Dashboard error:", err);
    return res.status(500).json({ success: false, message: "Failed to load dashboard." });
  }
};

// ─── USERS ────────────────────────────────────────────────────────────────────

exports.getUsers = async (req, res) => {
  try {
    const db = getDb();
    const snap = await db.collection("users").get();

    const users = snap.docs
      .map(doc => sanitizeUser(doc.id, doc.data()))
      .sort((a, b) => b.createdAt?._seconds - a.createdAt?._seconds);

    return res.status(200).json({ success: true, data: { users } });
  } catch (err) {
    console.error("Get users error:", err);
    return res.status(500).json({ success: false, message: "Failed to fetch users." });
  }
};

exports.banUser = async (req, res) => {
  try {
    const { id } = req.params;
    const db = getDb();

    const doc = await db.collection("users").doc(id).get();
    if (!doc.exists) {
      return res.status(404).json({ success: false, message: "User not found." });
    }

    const isBanned = !doc.data().isBanned;
    await db.collection("users").doc(id).update({ isBanned, updatedAt: new Date() });

    return res.status(200).json({
      success: true,
      message: isBanned ? "User banned." : "User unbanned.",
      data: { isBanned },
    });
  } catch (err) {
    console.error("Ban user error:", err);
    return res.status(500).json({ success: false, message: "Failed to update user." });
  }
};

// ─── TASKS ────────────────────────────────────────────────────────────────────

exports.getTasks = async (req, res) => {
  try {
    const db = getDb();
    const snap = await db.collection("tasks").get();

    const tasks = snap.docs
      .map(doc => ({ id: doc.id, ...doc.data() }))
      .sort((a, b) => b.createdAt?._seconds - a.createdAt?._seconds);

    return res.status(200).json({ success: true, data: { tasks } });
  } catch (err) {
    console.error("Get tasks error:", err);
    return res.status(500).json({ success: false, message: "Failed to fetch tasks." });
  }
};

exports.createTask = async (req, res) => {
  try {
    const { title, description, reward, type, brand, time, link, slots } = req.body;
    const db = getDb();

    const task = {
      title,
      description: description || "",
      reward:      parseFloat(reward),
      type,
      brand,
      time,
      link:        link || null,
      slots:       parseInt(slots) || 0,
      filled:      0,
      status:      "active",
      createdAt:   new Date(),
      updatedAt:   new Date(),
      createdBy:   req.user.uid,
    };

    const ref = await db.collection("tasks").add(task);

    return res.status(201).json({
      success: true,
      message: "Task created successfully.",
      data: { task: { id: ref.id, ...task } },
    });
  } catch (err) {
    console.error("Create task error:", err);
    return res.status(500).json({ success: false, message: "Failed to create task." });
  }
};

exports.updateTask = async (req, res) => {
  try {
    const { id } = req.params;
    const db = getDb();

    const doc = await db.collection("tasks").doc(id).get();
    if (!doc.exists) {
      return res.status(404).json({ success: false, message: "Task not found." });
    }

    const updates = { ...req.body, updatedAt: new Date() };
    if (updates.reward) updates.reward = parseFloat(updates.reward);
    if (updates.slots) updates.slots = parseInt(updates.slots);

    await db.collection("tasks").doc(id).update(updates);

    return res.status(200).json({ success: true, message: "Task updated successfully." });
  } catch (err) {
    console.error("Update task error:", err);
    return res.status(500).json({ success: false, message: "Failed to update task." });
  }
};

exports.deleteTask = async (req, res) => {
  try {
    const { id } = req.params;
    const db = getDb();

    const doc = await db.collection("tasks").doc(id).get();
    if (!doc.exists) {
      return res.status(404).json({ success: false, message: "Task not found." });
    }

    await db.collection("tasks").doc(id).delete();

    return res.status(200).json({ success: true, message: "Task deleted successfully." });
  } catch (err) {
    console.error("Delete task error:", err);
    return res.status(500).json({ success: false, message: "Failed to delete task." });
  }
};

// ─── PAYMENTS ─────────────────────────────────────────────────────────────────

exports.getPayments = async (req, res) => {
  try {
    const db = getDb();
    const snap = await db.collection("payments").get();

    const payments = snap.docs
      .map(doc => ({ id: doc.id, ...doc.data() }))
      .sort((a, b) => b.createdAt?._seconds - a.createdAt?._seconds);

    return res.status(200).json({ success: true, data: { payments } });
  } catch (err) {
    console.error("Get payments error:", err);
    return res.status(500).json({ success: false, message: "Failed to fetch payments." });
  }
};

exports.processPayment = async (req, res) => {
  try {
    const { id }     = req.params;
    const { action } = req.body;
    const db         = getDb();

    const payDoc = await db.collection("payments").doc(id).get();
    if (!payDoc.exists) {
      return res.status(404).json({ success: false, message: "Payment not found." });
    }
    const payment = payDoc.data();

    if (payment.status !== "pending") {
      return res.status(400).json({ success: false, message: "Payment already processed." });
    }

    if (action === "approve") {
      // Mark as approved — admin already sent the money manually via bank app
      await db.collection("payments").doc(id).update({
        status:     "approved",
        approvedAt: new Date(),
        updatedAt:  new Date(),
      });

      // Mark the linked transaction as completed
      const txSnap = await db.collection("transactions")
        .where("paymentId", "==", id).limit(1).get();
      if (!txSnap.empty) {
        await txSnap.docs[0].ref.update({ status: "completed" });
      }

      // Notify user
      await db.collection("notifications").add({
        userId:    payment.userId,
        title:     "💸 Withdrawal Processed!",
        body:      `Your withdrawal of $${payment.amountAfterFee?.toFixed(2)} (₦${Math.round(payment.amountNGN || 0).toLocaleString()}) to ${payment.bankName} has been sent. Check your account within 24 hours.`,
        type:      "paymentAlerts",
        read:      false,
        createdAt: new Date(),
      });

      return res.json({ success: true, message: "Withdrawal approved. User has been notified." });

    } else if (action === "reject") {
      // Refund balance back to user
      const userDoc = await db.collection("users").doc(payment.userId).get();
      if (userDoc.exists) {
        await db.collection("users").doc(payment.userId).update({
          balance:   (userDoc.data().balance || 0) + (payment.amount || 0),
          updatedAt: new Date(),
        });
      }

      await db.collection("payments").doc(id).update({
        status:     "rejected",
        rejectedAt: new Date(),
        updatedAt:  new Date(),
      });

      // Mark the linked transaction as failed
      const txSnap = await db.collection("transactions")
        .where("paymentId", "==", id).limit(1).get();
      if (!txSnap.empty) {
        await txSnap.docs[0].ref.update({ status: "failed" });
      }

      // Notify user + tell them they were refunded
      await db.collection("notifications").add({
        userId:    payment.userId,
        title:     "⚠️ Withdrawal Not Processed",
        body:      `Your withdrawal of $${payment.amount?.toFixed(2)} could not be processed. Your balance has been refunded. Please contact support if you need help.`,
        type:      "paymentAlerts",
        read:      false,
        createdAt: new Date(),
      });

      return res.json({ success: true, message: "Withdrawal rejected and balance refunded to user." });

    } else {
      return res.status(400).json({ success: false, message: "Invalid action. Use 'approve' or 'reject'." });
    }

  } catch (err) {
    console.error("Process payment error:", err);
    return res.status(500).json({ success: false, message: "Server error." });
  }
};

// ─── REFERRALS ────────────────────────────────────────────────────────────────

exports.getReferrals = async (req, res) => {
  try {
    const db = getDb();
    const snap = await db.collection("users")
      .where("referredBy", "!=", null)
      .get();

    const referrals = await Promise.all(
      snap.docs.map(async doc => {
        const user = sanitizeUser(doc.id, doc.data());
        let referredByUser = null;

        if (user.referredBy) {
          const refDoc = await db.collection("users").doc(user.referredBy).get();
          if (refDoc.exists) {
            referredByUser = sanitizeUser(refDoc.id, refDoc.data());
          }
        }

        return {
          uid: user.uid,
          name: `${user.firstName} ${user.lastName}`,
          email: user.email,
          username: user.username,
          joinedAt: user.createdAt,
          referredBy: referredByUser ? {
            uid: referredByUser.uid,
            name: `${referredByUser.firstName} ${referredByUser.lastName}`,
            username: referredByUser.username,
          } : null,
        };
      })
    );

    return res.status(200).json({ success: true, data: { referrals } });
  } catch (err) {
    console.error("Get referrals error:", err);
    return res.status(500).json({ success: false, message: "Failed to fetch referrals." });
  }
};