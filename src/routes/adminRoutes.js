const express = require("express");
const { getDb } = require('../config/firebase');
const router = express.Router();
const adminMiddleware = require("../middleware/adminMiddleware");
const {
  getDashboard,
  getUsers, banUser,
  getTasks, createTask, updateTask, deleteTask,
  getPayments, processPayment,
  getReferrals,
  getReactivations, processReactivation,   // ← add this line
} = require("../controllers/adminController");
const {
  broadcastMessage,
  sendSingleMessage,
  getMessageHistory,
} = require("../controllers/Adminmessagescontroller");

// All routes protected by adminMiddleware
router.use(adminMiddleware);

// Dashboard
router.get("/dashboard", getDashboard);

// Users
router.get("/users", getUsers);
router.put("/users/:id/ban", banUser);

// Tasks
router.get("/tasks", getTasks);
router.post("/tasks", createTask);
router.put("/tasks/:id", updateTask);
router.delete("/tasks/:id", deleteTask);

// Payments
router.get("/payments", getPayments);
router.put("/payments/:id", processPayment);

router.patch("/campaigns/:id/status", authMiddleware, adminController.updateCampaignStatus);
// Reactivations
router.get("/reactivations",       getReactivations);
router.put("/reactivations/:id",   processReactivation);

// Referrals
router.get("/referrals", getReferrals);

// Messages
router.post("/messages/broadcast", broadcastMessage);
router.post("/messages/single",    sendSingleMessage);
router.get("/messages/history",    getMessageHistory);

const { checkInactiveUsers, banAndNotifyUser } = require('../jobs/inactivityJob');

// Manual inactivity ban — trigger for a single user
router.post('/users/:id/inactivity-ban', async (req, res) => {
  try {
    const db      = getDb();
    const { id }  = req.params;

    const doc = await db.collection('users').doc(id).get();
    if (!doc.exists) {
      return res.status(404).json({ success: false, message: 'User not found.' });
    }

    const user = doc.data();

    if (user.isBanned) {
      return res.status(400).json({ success: false, message: 'User is already banned.' });
    }

    await banAndNotifyUser(db, { ...user, bannedReason: null }, id);

    return res.status(200).json({
      success: true,
      message: `User banned and suspension email sent to ${user.email}.`,
    });
  } catch (err) {
    console.error('Manual inactivity ban error:', err);
    return res.status(500).json({ success: false, message: 'Failed to ban user.' });
  }
});

// Manual run — check all inactive users now
router.post('/run-inactivity-check', async (req, res) => {
  try {
    await checkInactiveUsers();
    return res.status(200).json({ success: true, message: 'Inactivity check completed.' });
  } catch (err) {
    console.error('Manual inactivity check error:', err);
    return res.status(500).json({ success: false, message: 'Failed to run check.' });
  }
});

module.exports = router;