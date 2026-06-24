const express          = require("express");
const { getDb }        = require("../config/firebase");
const { protect }      = require("../middleware/authMiddleware");
const { requireMinVersion } = require("../controllers/userController");

const router = express.Router();

// POST /api/v1/tasks/:id/submit-proof
router.post("/:id/submit-proof", protect, async (req, res) => {
  try {
    if (!requireMinVersion(req, res)) return;
    const taskId                     = req.params.id;
    const userId                     = req.user.uid;
    const { base64Image, taskTitle } = req.body;
    
console.log("[submit-proof] base64Image length:", base64Image ? base64Image.length : "NULL/UNDEFINED");
    const db                         = getDb();

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
    // 3. Proof image required + size guard (Firestore limit ~1 MB per field)
    if (!base64Image) {
        return res.status(400).json({ success: false, message: "No proof image provided." });
      }
      const imageSizeBytes = Buffer.byteLength(base64Image, "base64");
      if (imageSizeBytes > 900_000) {
        return res.status(400).json({
          success: false,
          message: "Screenshot is too large. Please crop or retake it at a lower resolution.",
        });
      }

    // 4. Get user info
    const userDoc = await db.collection("users").doc(userId).get();
    const user    = userDoc.exists ? userDoc.data() : {};

    // 5. Save submission to Firestore
    await db.collection("taskSubmissions").add({
      taskId,
      taskTitle:   task.title  || taskTitle || "",
      taskReward:  task.reward || 0,
      userId,
      username:    user.username    || "",
      displayName: `${user.firstName || ""} ${user.lastName || ""}`.trim(),
      email:       user.email       || "",
      proofBase64: base64Image,
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