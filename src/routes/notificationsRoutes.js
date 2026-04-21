const express  = require("express");
const router   = express.Router();
const { protect } = require("../middleware/authMiddleware");
const {
  getNotifications,
  markAllRead,
  markOneRead,
  savePushToken,
  savePreferences,
} = require("../controllers/notificationsController");

router.get("/",              protect, getNotifications);
router.put("/read-all",      protect, markAllRead);
router.put("/:id/read",      protect, markOneRead);
router.post("/push-token",   protect, savePushToken);
router.post("/preferences",  protect, savePreferences);

module.exports = router;