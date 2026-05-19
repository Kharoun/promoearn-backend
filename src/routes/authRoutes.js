const express    = require("express");
const rateLimit  = require("express-rate-limit");
const router     = express.Router();

const {
  register, login, verifyEmail, verifyPhone, resendOtp,
  refreshToken, forgotPassword, verifyResetOtp, resetPassword,
  getMe, logout, changeUsername, changePassword, googleLogin,
  toggleTwoFA, deleteAccount,
} = require("../controllers/authController");
const { protect } = require("../middleware/authMiddleware");  
const {
  validate,
  registerRules,
  loginRules,
  otpRules,
  forgotPasswordRules,
  resetPasswordRules,
} = require("../middleware/validationMiddleware");

// ─── Rate Limiters ────────────────────────────────────────────────────────────
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { success: false, message: "Too many requests. Please try again in 15 minutes." },
  standardHeaders: true,
  legacyHeaders:   false,
});

const otpLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 5,
  message: { success: false, message: "Too many OTP requests. Please wait 10 minutes." },
});

const forgotLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  message: { success: false, message: "Too many reset requests. Please try again in an hour." },
});

// ─── Public Routes ────────────────────────────────────────────────────────────

router.post("/register",          authLimiter,   registerRules,        validate, register);
router.post("/login",             authLimiter,   loginRules,           validate, login);
router.post("/verify-email",      otpLimiter,    otpRules,             validate, verifyEmail);
router.post("/verify-phone",      otpLimiter,    otpRules,             validate, verifyPhone);
router.post("/resend-otp",        otpLimiter,    resendOtp);
router.post("/refresh-token",     refreshToken);
router.post("/forgot-password",    forgotLimiter, forgotPasswordRules, validate, forgotPassword);
router.post("/verify-reset-otp",   verifyResetOtp);
router.post("/reset-password",     resetPasswordRules, validate, resetPassword);
router.post("/google",            authLimiter,   googleLogin);

// ─── Protected Routes ─────────────────────────────────────────────────────────

router.get("/me",                 protect, getMe);
router.post("/logout",            protect, logout);
router.post("/change-username",   protect, changeUsername);
router.post("/change-password",   protect, changePassword);
router.post("/toggle-2fa",        protect, toggleTwoFA);       // ← add this
router.delete("/delete-account",  protect, deleteAccount);     // ← add this

module.exports = router;