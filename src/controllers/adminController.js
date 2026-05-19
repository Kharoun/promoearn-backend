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
    const admin      = require("firebase-admin");
    const axios      = require("axios");
    const PAYSTACK_SECRET = process.env.PAYSTACK_SECRET_KEY;

    if (!["approve", "reject"].includes(action)) {
      return res.status(400).json({ success: false, message: "Action must be 'approve' or 'reject'." });
    }

    const paymentDoc = await db.collection("payments").doc(id).get();
    if (!paymentDoc.exists) {
      return res.status(404).json({ success: false, message: "Payment not found." });
    }

    const payment = paymentDoc.data();

    if (payment.status !== "pending") {
      return res.status(400).json({ success: false, message: "This payment has already been processed." });
    }

    // ── REJECT: refund balance, mark rejected ───────────────────────────────
    if (action === "reject") {
      await db.collection("payments").doc(id).update({
        status:      "rejected",
        processedAt: new Date(),
        processedBy: req.user.uid,
        updatedAt:   new Date(),
      });

      const userDoc = await db.collection("users").doc(payment.userId).get();
      if (userDoc.exists) {
        await db.collection("users").doc(payment.userId).update({
          balance:   (userDoc.data().balance || 0) + payment.amount,
          updatedAt: new Date(),
        });

        const txSnap = await db.collection("transactions")
          .where("paymentId", "==", id).limit(1).get();
        if (!txSnap.empty) {
          await txSnap.docs[0].ref.update({ status: "rejected" });
        }

        await db.collection("notifications").add({
          userId:    payment.userId,
          title:     "❌ Withdrawal Rejected",
          message:   `Your withdrawal of $${payment.amount.toFixed(2)} was rejected and your balance has been refunded. Contact support if you have questions.`,
          type:      "bonus",
          read:      false,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
        });
      }

      return res.json({ success: true, message: "Payment rejected and balance refunded." });
    }

    // ── APPROVE: fire Paystack transfer now ─────────────────────────────────

    // Step A: create transfer recipient
    let recipientCode;
    try {
      const recipientRes = await axios.post(
        "https://api.paystack.co/transferrecipient",
        {
          type:           "nuban",
          name:           payment.accountName,
          account_number: payment.accountNumber,
          bank_code:      payment.bankCode || "",
          currency:       "NGN",
        },
        { headers: { Authorization: `Bearer ${PAYSTACK_SECRET}` } }
      );
      recipientCode = recipientRes.data?.data?.recipient_code;
      if (!recipientCode) throw new Error("No recipient code returned");
    } catch (err) {
      console.error("Recipient creation failed:", err.response?.data || err.message);
      return res.status(502).json({ success: false, message: "Failed to create transfer recipient. Check bank details." });
    }

    // Step B: initiate transfer
    const amountKobo = Math.round((payment.amountAfterFee || payment.amount) * 1500 * 100);
    let transferCode, transferStatus;
    try {
      const transferRes = await axios.post(
        "https://api.paystack.co/transfer",
        {
          source:    "balance",
          amount:    amountKobo,
          recipient: recipientCode,
          reason:    `PromoEarn withdrawal for @${payment.username}`,
        },
        { headers: { Authorization: `Bearer ${PAYSTACK_SECRET}` } }
      );

      if (!transferRes.data?.status) {
        const psMsg = transferRes.data?.message || "Transfer failed";
        console.error("Paystack transfer failed:", psMsg);
        return res.status(502).json({ success: false, message: `Paystack: ${psMsg}` });
      }

      transferCode   = transferRes.data.data.transfer_code;
      transferStatus = transferRes.data.data.status;
    } catch (err) {
      console.error("Transfer failed:", err.response?.data || err.message);
      return res.status(502).json({ success: false, message: "Transfer failed. Check Paystack balance and try again." });
    }

    // Step C: mark approved in Firestore
    await db.collection("payments").doc(id).update({
      status:        "approved",
      recipientCode,
      transferCode,
      transferStatus,
      processedAt:   new Date(),
      processedBy:   req.user.uid,
      updatedAt:     new Date(),
    });

    const txSnap = await db.collection("transactions")
      .where("paymentId", "==", id).limit(1).get();
    if (!txSnap.empty) {
      await txSnap.docs[0].ref.update({ status: "approved", transferCode });
    }

    await db.collection("notifications").add({
      userId:    payment.userId,
      title:     "✅ Withdrawal Approved!",
      message:   `Your withdrawal of $${(payment.amountAfterFee || payment.amount).toFixed(2)} (₦${((payment.amountNGN) || 0).toLocaleString()}) to ${payment.bankName} has been approved and sent. Arrives within 24 hours.`,
      type:      "bonus",
      read:      false,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    return res.json({
      success: true,
      message: `Transfer sent to ${payment.accountName} at ${payment.bankName}.`,
    });

  } catch (err) {
    console.error("Process payment error:", err);
    return res.status(500).json({ success: false, message: "Failed to process payment." });
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