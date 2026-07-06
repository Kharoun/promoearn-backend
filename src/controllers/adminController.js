const { getDb } = require("../config/firebase");
const { flw } = require("../utils/flutterwave");
const { Resend } = require('resend');
const { createNotification } = require('./notificationsController');
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
      try {
        // Manual approval — admin has already sent the money from their own bank.
        // No Flutterwave Transfer API call, so no IP whitelisting needed.
        await db.collection("payments").doc(id).update({
          status:     "completed",
          approvedAt: new Date(),
          updatedAt:  new Date(),
        });

        const txSnap = await db.collection("transactions")
          .where("paymentId", "==", id).limit(1).get();
        if (!txSnap.empty) {
          await txSnap.docs[0].ref.update({ status: "completed" });
        }

        await createNotification(payment.userId, {
          title: "💸 Withdrawal Processed!",
          body:  `Your withdrawal of $${(payment.amountAfterFee || payment.amount).toFixed(2)} (₦${Math.round(payment.amountNGN || 0).toLocaleString()}) to ${payment.bankName} has been sent.`,
          type:  "paymentAlerts",
        });

        return res.json({
          success: true,
          message: "Withdrawal marked as completed. User has been notified.",
        });
      } catch (err) {
        console.error("Manual approval error:", err);
        return res.status(500).json({ success: false, message: "Failed to approve withdrawal." });
      }

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
// ─── REACTIVATIONS ────────────────────────────────────────────────────────────
// ─── REACTIVATIONS ────────────────────────────────────────────────────────────


exports.getReactivations = async (req, res) => {
  try {
    const db   = getDb();
    const snap = await db.collection('reactivations').get();
    const reactivations = snap.docs
      .map(doc => ({ id: doc.id, ...doc.data() }))
      .sort((a, b) => (b.createdAt?._seconds || 0) - (a.createdAt?._seconds || 0));
    return res.status(200).json({ success: true, data: { reactivations } });
  } catch (err) {
    console.error('Get reactivations error:', err);
    return res.status(500).json({ success: false, message: 'Failed to fetch reactivations.' });
  }
};

exports.processReactivation = async (req, res) => {
  try {
    const { id }                      = req.params;
    const { action, rejectReason }    = req.body;
    // action = "approve" | "reject"

    if (!['approve', 'reject'].includes(action)) {
      return res.status(400).json({ success: false, message: "Invalid action. Use 'approve' or 'reject'." });
    }

    const db      = getDb();
    const docRef  = db.collection('reactivations').doc(id);
    const docSnap = await docRef.get();

    if (!docSnap.exists) {
      return res.status(404).json({ success: false, message: "Reactivation request not found." });
    }

    const reactData = docSnap.data();

    if (reactData.status !== 'pending') {
      return res.status(400).json({ success: false, message: "This request has already been processed." });
    }

    const uid = reactData.userId;

    const userDoc = await db.collection('users').doc(uid).get();
    if (!userDoc.exists) {
      return res.status(404).json({ success: false, message: "User not found." });
    }

    const resend = new Resend(process.env.RESEND_API_KEY);

    if (action === 'approve') {
      // 1. Unban user and clear the reactivation token
      await db.collection('users').doc(uid).update({
        isBanned:                false,
        bannedReason:            null,
        bannedAt:                null,
        reactivationToken:       null,
        reactivationTokenExpiry: null,
        reactivatedAt:           new Date(),
        updatedAt:               new Date(),
      });

      // 2. Mark the reactivation record as approved
      await docRef.update({
        status:     'approved',
        approvedAt: new Date(),
        approvedBy: req.user.uid,
      });

      // 3. In-app notification
      await createNotification(uid, {
        title: '🎉 Account Reactivated!',
        body:  'Your transfer has been confirmed. Your account is fully restored — you can now log in and start earning again!',
        type:  'paymentAlerts',
      });

      // 4. Email the user
      await resend.emails.send({
        from:    'PromoEarn <noreply@promoearnapp.com>',
        to:      reactData.email,
        subject: '✅ Your PromoEarn Account Has Been Reactivated',
        html: `
          <div style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:20px">
            <div style="background:#16A34A;padding:20px;border-radius:12px 12px 0 0;text-align:center">
              <h2 style="color:#fff;margin:0">PromoEarn</h2>
            </div>
            <div style="background:#fff;padding:28px;border:1px solid #E2E8F0;border-top:none;border-radius:0 0 12px 12px">
              <p style="font-size:15px;color:#0F172A">Hi <strong>${reactData.firstName || 'there'}</strong>,</p>
              <p style="font-size:15px;line-height:1.7;color:#0F172A">
                Great news! We've confirmed your transfer and your PromoEarn account has been <strong>fully reactivated</strong>.
              </p>
              <div style="background:#F0FDF4;border-left:4px solid #16A34A;padding:14px;border-radius:0 8px 8px 0;margin:20px 0">
                <p style="margin:0;color:#166534;font-weight:600;">✅ Your account is now active.</p>
              </div>
              <ul style="color:#0F172A;line-height:2;font-size:14px;">
                <li>💰 All your earnings and progress have been restored</li>
                <li>🎯 You can start completing tasks again immediately</li>
              </ul>
              <div style="text-align:center;margin:28px 0;">
                <a href="https://app.promoearnapp.com"
                   style="display:inline-block;background:#16A34A;color:#fff;padding:16px 36px;border-radius:10px;text-decoration:none;font-weight:700;font-size:16px;">
                  👉 Log In Now
                </a>
              </div>
              <hr style="border:none;border-top:1px solid #E2E8F0;margin:24px 0"/>
              <p style="font-size:12px;color:#94A3B8;text-align:center">
                © ${new Date().getFullYear()} PromoEarn. All rights reserved.
              </p>
            </div>
          </div>
        `,
      });

      return res.json({ success: true, message: "User reactivated and notified by email." });

    } else {
      // REJECT

      // 1. Mark the reactivation record as rejected
      await docRef.update({
        status:       'rejected',
        rejectReason: rejectReason || 'Transfer could not be confirmed.',
        rejectedAt:   new Date(),
        rejectedBy:   req.user.uid,
      });

      // 2. In-app notification
      await createNotification(uid, {
        title: '⚠️ Reactivation Not Confirmed',
        body:  rejectReason || 'We could not confirm your transfer. Please contact support for help.',
        type:  'paymentAlerts',
      });

      // 3. Email the user
      await resend.emails.send({
        from:    'PromoEarn <noreply@promoearnapp.com>',
        to:      reactData.email,
        subject: '⚠️ Reactivation Request Not Confirmed',
        html: `
          <div style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:20px">
            <div style="background:#DC2626;padding:20px;border-radius:12px 12px 0 0;text-align:center">
              <h2 style="color:#fff;margin:0">PromoEarn</h2>
            </div>
            <div style="background:#fff;padding:28px;border:1px solid #E2E8F0;border-top:none;border-radius:0 0 12px 12px">
              <p style="font-size:15px;color:#0F172A">Hi <strong>${reactData.firstName || 'there'}</strong>,</p>
              <p style="font-size:15px;line-height:1.7;color:#0F172A">
                Unfortunately, we could not confirm your reactivation transfer.
              </p>
              <div style="background:#FEF2F2;border-left:4px solid #EF4444;padding:14px;border-radius:0 8px 8px 0;margin:20px 0">
                <p style="margin:0;color:#991B1B;font-weight:600;">
                  Reason: ${rejectReason || 'Transfer not confirmed.'}
                </p>
              </div>
              <p style="font-size:14px;color:#374151;">
                If you believe this is a mistake or need help, please contact our support team.
              </p>
              <div style="text-align:center;margin:28px 0;">
                <a href="mailto:contact.promoearn@gmail.com"
                   style="display:inline-block;background:#1E40AF;color:#fff;padding:14px 32px;border-radius:10px;text-decoration:none;font-weight:700;font-size:15px;">
                  📧 Contact Support
                </a>
              </div>
              <hr style="border:none;border-top:1px solid #E2E8F0;margin:24px 0"/>
              <p style="font-size:12px;color:#94A3B8;text-align:center">
                © ${new Date().getFullYear()} PromoEarn. All rights reserved.
              </p>
            </div>
          </div>
        `,
      });

      return res.json({ success: true, message: "Reactivation rejected. User has been notified." });
    }

  } catch (err) {
    console.error("processReactivation error:", err);
    return res.status(500).json({ success: false, message: "Server error." });
  }
};
// ─── UPDATE CAMPAIGN STATUS ───────────────────────────────────────────────────
exports.updateCampaignStatus = async (req, res) => {
  try {
    const { id }                = req.params;
    const { status, adminNote } = req.body;
    const db = getDb();

    const validStatuses = ["approved", "rejected", "live", "completed"];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ success: false, message: `Invalid status. Must be one of: ${validStatuses.join(", ")}` });
    }

    const campaignDoc = await db.collection("campaigns").doc(id).get();
    if (!campaignDoc.exists) {
      return res.status(404).json({ success: false, message: "Campaign not found." });
    }

    const update = { status, updatedAt: new Date() };
    if (adminNote !== undefined) update.adminNote  = adminNote;
    if (status === "live")       update.liveAt      = new Date();
    if (status === "completed")  update.completedAt = new Date();

    await db.collection("campaigns").doc(id).update(update);

    // Notify the campaign owner
    const campaign = campaignDoc.data();
    const ownerId  = campaign.submittedBy;
    if (ownerId) {
      const messages = {
        approved:  { title: "🎉 Campaign Approved!", body: `Your campaign "${campaign.brandName}" has been approved and will go live soon.` },
        rejected:  { title: "❌ Campaign Rejected",  body: `Your campaign "${campaign.brandName}" was rejected.${adminNote ? ` Reason: ${adminNote}` : ""}` },
        live:      { title: "🚀 Campaign is Live!",  body: `Your campaign "${campaign.brandName}" is now live and earning for you.` },
        completed: { title: "✅ Campaign Completed", body: `Your campaign "${campaign.brandName}" has completed its run.` },
      };
      const msg = messages[status];
      if (msg) {
        await db.collection("notifications").add({
          userId:    ownerId,
          title:     msg.title,
          message:   msg.body,
          type:      "campaign",
          read:      false,
          createdAt: new Date(),
        });
      }
    }

    return res.json({ success: true, message: `Campaign ${status}.` });
  } catch (err) {
    console.error("Update campaign status error:", err);
    return res.status(500).json({ success: false, message: "Server error." });
  }
};
// ─── TASK SUBMISSIONS (Proof Review) ─────────────────────────────────────────

exports.getTaskSubmissions = async (req, res) => {
  try {
    const db     = getDb();
    const status = req.query.status || "all";

    let query = db.collection("taskSubmissions");
    if (status !== "all") query = query.where("status", "==", status);

    const snap = await query.get();

    // Get unique userIds to fetch in batch
    const userIds = [...new Set(snap.docs.map(doc => doc.data().userId).filter(Boolean))];

    // Fetch all users in parallel
    const userDocs = await Promise.all(
      userIds.map(uid => db.collection("users").doc(uid).get())
    );
    const usersMap = {};
    userDocs.forEach(doc => {
      if (doc.exists) usersMap[doc.id] = doc.data();
    });

    const submissions = snap.docs
      .map(doc => {
        const data = doc.data();
        const user = usersMap[data.userId] || {};

        return {
          id:          doc.id,
          userId:      data.userId,
          taskId:      data.taskId,
          taskTitle:   data.taskTitle,
          taskReward:  data.taskReward,
          status:      data.status,
          note:        data.note      || "",
          submittedAt: data.submittedAt,
          approvedAt:  data.approvedAt  || null,
          rejectedAt:  data.rejectedAt  || null,
          // User info enriched here
          displayName: `${user.firstName || ""} ${user.lastName || ""}`.trim() || user.username || "Unknown",
          username:    user.username  || "unknown",
          email:       user.email     || "—",
          // Send base64 only if pending — approved/rejected don't need the image anymore
          proofBase64: data.status === "pending" ? (data.proofBase64 || null) : null,
          proofUrl:    data.proofUrl || null,
        };
      })
      .sort((a, b) => (b.submittedAt?._seconds || 0) - (a.submittedAt?._seconds || 0));

    return res.json({ success: true, data: { submissions } });
  } catch (err) {
    console.error("getTaskSubmissions error:", err);
    return res.status(500).json({ success: false, message: "Server error." });
  }
};

exports.processTaskSubmission = async (req, res) => {
  try {
    const { id }           = req.params;
    const { action, note } = req.body;
    const db               = getDb();

    const subDoc = await db.collection("taskSubmissions").doc(id).get();
    if (!subDoc.exists) {
      return res.status(404).json({ success: false, message: "Submission not found." });
    }
    const sub = subDoc.data();

    if (sub.status !== "pending") {
      return res.status(400).json({ success: false, message: "Submission already processed." });
    }

    if (action === "approve") {
      const userDoc = await db.collection("users").doc(sub.userId).get();
      if (!userDoc.exists) {
        return res.status(404).json({ success: false, message: "User not found." });
      }
      const user   = userDoc.data();
      const reward = parseFloat(sub.taskReward) || 0;

      await db.collection("users").doc(sub.userId).update({
        balance:        (user.balance        || 0) + reward,
        totalEarned:    (user.totalEarned    || 0) + reward,
        tasksCompleted: (user.tasksCompleted || 0) + 1,
        updatedAt:      new Date(),
      });

      await db.collection("transactions").add({
        userId:      sub.userId,
        type:        "task",
        description: `Task reward: ${sub.taskTitle}`,
        amount:      reward,
        status:      "completed",
        taskId:      sub.taskId,
        createdAt:   new Date(),
      });

      await db.collection("tasks").doc(sub.taskId).update({
        filled: require("firebase-admin").firestore.FieldValue.increment(1),
      });

      await db.collection("taskSubmissions").doc(id).update({
        status:     "approved",
        note:       note || "",
        approvedAt: new Date(),
      });

      await db.collection("notifications").add({
        userId:    sub.userId,
        title:     "🎉 Task Approved!",
        body:      `Your proof for "${sub.taskTitle}" was approved. +$${reward.toFixed(2)} has been added to your balance.`,
        type:      "taskRewards",
        read:      false,
        createdAt: new Date(),
      });

      return res.json({ success: true, message: "Submission approved and reward credited." });

    } else if (action === "reject") {
      await db.collection("taskSubmissions").doc(id).update({
        status:     "rejected",
        note:       note || "Proof did not meet requirements.",
        rejectedAt: new Date(),
      });

      await db.collection("notifications").add({
        userId:    sub.userId,
        title:     "❌ Task Proof Rejected",
        body:      note || `Your proof for "${sub.taskTitle}" was rejected. Please re-read the instructions and try again.`,
        type:      "taskRewards",
        read:      false,
        createdAt: new Date(),
      });

      return res.json({ success: true, message: "Submission rejected." });
    } else {
      return res.status(400).json({ success: false, message: "Invalid action." });
    }
  } catch (err) {
    console.error("processTaskSubmission error:", err);
    return res.status(500).json({ success: false, message: "Server error." });
  }
};