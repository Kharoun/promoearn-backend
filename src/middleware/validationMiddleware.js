const { body, validationResult } = require("express-validator");

const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(422).json({
      success: false,
      message: "Validation failed",
      errors: errors.array().map((e) => ({ field: e.path, message: e.msg })),
    });
  }
  next();
};

const normalizePhone = (phone) => {
  let cleaned = phone.replace(/[\s\-().]/g, "");
  if (/^0[7-9][0-1]\d{8}$/.test(cleaned)) return "+234" + cleaned.slice(1);
  if (/^[1-9]\d{9,14}$/.test(cleaned)) return "+" + cleaned;
  return cleaned;
};

const registerRules = [
  body("firstName").trim().notEmpty().withMessage("First name is required"),
  body("lastName").trim().notEmpty().withMessage("Last name is required"),
  body("email").trim().isEmail().normalizeEmail().withMessage("Valid email is required"),
  body("phone")
  .optional({ checkFalsy: true })
  .customSanitizer((value) => value ? normalizePhone(value) : value)
  .matches(/^\+[1-9]\d{7,14}$/)
  .withMessage("Please enter a valid phone number (e.g. 07015662471)"),
  body("password").isLength({ min: 6 }).withMessage("Password must be at least 6 characters"),
  body("confirmPassword").custom((val, { req }) => {
    if (val !== req.body.password) throw new Error("Passwords do not match");
    return true;
  }),
  body("username")
    .trim()
    .isLength({ min: 3, max: 20 })
    .matches(/^[a-zA-Z0-9_]+$/)
    .withMessage("Username must be 3-20 characters (letters, numbers, underscores)"),
  body("dob").notEmpty().withMessage("Date of birth is required"),
  body("gender").isIn(["Male", "Female", "Other"]).withMessage("Gender must be Male, Female, or Other"),
];

const loginRules = [
  body("identifier")
    .trim()
    .notEmpty()
    .withMessage("Email or phone number is required")
    .customSanitizer((value) => {
      if (!value.includes("@")) return normalizePhone(value);
      return value;
    }),
  body("password").notEmpty().withMessage("Password is required"),
];

const otpRules = [
  body("otp").trim().isLength({ min: 6, max: 6 }).isNumeric().withMessage("OTP must be a 6-digit number"),
];

const forgotPasswordRules = [
  body("email")
    .trim()
    .notEmpty().withMessage("Email is required")
    .isEmail().withMessage("Please enter a valid email address")
    .normalizeEmail(),
];

const resetPasswordRules = [
  body("email")
    .trim()
    .notEmpty().withMessage("Email is required")
    .isEmail().withMessage("Valid email is required")
    .normalizeEmail(),
  body("resetToken")
    .trim()
    .notEmpty().withMessage("Reset token is required"),
  body("newPassword")
    .isLength({ min: 6 }).withMessage("Password must be at least 6 characters"),
];

module.exports = {
  validate,
  normalizePhone,
  registerRules,
  loginRules,
  otpRules,
  forgotPasswordRules,
  resetPasswordRules,
};