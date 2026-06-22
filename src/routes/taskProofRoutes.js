const express        = require("express");
const { getDb }      = require("../config/firebase");
const authMiddleware = require("../middleware/authMiddleware"); // adjust name if needed

const router = express.Router();

// POST /api/v1/tasks/:id/submit-proof
router.post("/:id/submit-proof", authMiddleware, async (req, res) => {
  try {
    const taskId      = req.params.id;
    const userId      = req.user.uid;
    const { base64Image, taskTitle } = req.body;
    const db          = getDb();

    // 1. Task must exist
    const taskDoc = await db.collection("tasks").doc(taskId).get();
    if (!taskDoc.exists) {
      return res.status(404).json({ success: false, message: "Task not found." });
    }
    const task = taskDoc.data();

    // 2. No duplicate pending/approved submissions
    const existing = await db.collection("taskSubmissions")
      .where("taskId", "==", taskId)
      .where("userId", "==", userId)
      .where("status", "in", ["pending", "approved"])
      .limit(1).get();

    if (!existing.empty) {
      return res.status(400).json({
        success: false,
        message: "You already submitted proof for this task.",
      });
    }

    // 3. Proof image required
    if (!base64Image) {
      return res.status(400).json({ success: false, message: "No proof image provided." });
    }

    // 4. Get user info
    const userDoc = await db.collection("users").doc(userId).get();
    const user    = userDoc.exists ? userDoc.data() : {};

    // 5. Save submission to Firestore (image stored as base64)
    await db.collection("taskSubmissions").add({
      taskId,
      taskTitle:   task.title  || taskTitle || "",
      taskReward:  task.reward || 0,
      userId,
      username:    user.username    || "",
      displayName: `${user.firstName || ""} ${user.lastName || ""}`.trim(),
      email:       user.email       || "",
      proofBase64: base64Image,           // stored directly in Firestore
      proofUrl:    null,
      status:      "pending",
      submittedAt: new Date(),
    });

    return res.json({
      success: true,
      message: "Proof submitted! Your reward will be added once approved.",
    });

  } catch (err) {
    console.error("submit-proof error:", err);
    return res.status(500).json({ success: false, message: "Server error. Try again." });
  }
});

module.exports = router;