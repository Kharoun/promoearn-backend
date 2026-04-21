const express  = require("express");
const router   = express.Router();
const { protect } = require("../middleware/authMiddleware");
const {
  getTasks,
  completeTask,
  getMyReferrals,
  getLeaderboard,
} = require("../controllers/userController");

// Public
router.get("/leaderboard", getLeaderboard);

// Protected
router.get("/tasks",            protect, getTasks);
router.post("/tasks/:id/complete", protect, completeTask);
router.get("/referrals/mine",   protect, getMyReferrals);

// Leaderboard (public)
router.get("/leaderboard", getLeaderboard);
module.exports = router;