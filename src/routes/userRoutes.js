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
// ── your existing routes above this line ──

// ── PASTE THIS ENTIRE BLOCK ──
const multer = require("multer");
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

router.post("/:id/submit-proof", protect, upload.single("proof"), async (req, res) => {
  try {
    const db     = require("firebase-admin").firestore();
    const admin  = require("firebase-admin");
    const taskId = req.params.id;
    const uid    = req.user.uid;

    const taskDoc = await db.collection("tasks").doc(taskId).get();
    if (!taskDoc.exists) {
      return res.status(404).json({ success: false, message: "Task not found." });
    }
    const task = taskDoc.data();

    const existing = await db.collection("taskSubmissions")
      .where("taskId", "==", taskId)
      .where("userId", "==", uid)
      .where("status", "in", ["pending", "approved"])
      .limit(1).get();
    if (!existing.empty) {
      return res.status(400).json({ success: false, message: "You already submitted proof for this task." });
    }

    let proofUrl = null;
    if (req.file) {
      try {
        const bucket   = admin.storage().bucket();
        const filename = `task-proofs/${uid}_${taskId}_${Date.now()}.jpg`;
        const fileRef  = bucket.file(filename);
        await fileRef.save(req.file.buffer, {
          metadata: { contentType: req.file.mimetype || "image/jpeg" },
          public:   true,
        });
        proofUrl = `https://storage.googleapis.com/${bucket.name}/${filename}`;
      } catch (uploadErr) {
        console.error("Proof image upload failed:", uploadErr.message);
      }
    }

    const userDoc = await db.collection("users").doc(uid).get();
    const user = userDoc.exists ? userDoc.data() : {};

    const subRef = await db.collection("taskSubmissions").add({
      taskId,
      taskTitle:   task.title    || "",
      taskReward:  parseFloat(task.reward) || 0,
      userId:      uid,
      username:    user.username || "",
      email:       user.email   || "",
      displayName: [user.firstName, user.lastName].filter(Boolean).join(" ") || user.username || "",
      proofUrl,
      status:      "pending",
      submittedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    await db.collection("adminNotifications").add({
      type:      "task_proof",
      taskId,
      userId:    uid,
      email:     user.email || "",
      taskTitle: task.title || "",
      message:   `New task proof from ${user.username || uid} for "${task.title}"`,
      read:      false,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    return res.json({
      success: true,
      message: "Proof submitted! Reward will be credited once approved.",
      data:    { submissionId: subRef.id },
    });

  } catch (err) {
    console.error("submit-proof error:", err);
    return res.status(500).json({ success: false, message: "Server error." });
  }
});
// ── END OF PASTE ──

module.exports = router;   // ← this line should already be here