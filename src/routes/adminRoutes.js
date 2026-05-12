const express = require("express");
const router = express.Router();
const adminMiddleware = require("../middleware/adminMiddleware");
const {
  getDashboard,
  getUsers, banUser,
  getTasks, createTask, updateTask, deleteTask,
  getPayments, processPayment,
  getReferrals,
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

// Referrals
router.get("/referrals", getReferrals);

// Messages
router.post("/messages/broadcast", broadcastMessage);
router.post("/messages/single",    sendSingleMessage);
router.get("/messages/history",    getMessageHistory);

module.exports = router;