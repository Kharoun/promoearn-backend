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

// All routes are protected by adminMiddleware
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


module.exports = router;