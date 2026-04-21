# 🔐 PromoEarn Auth API

Node.js + Express + Firebase Firestore authentication backend with **Email OTP** verification and **SMS OTP** via Twilio.

---

## 📁 Project Structure

```
promoearn-auth/
├── src/
│   ├── server.js                  # Entry point
│   ├── config/
│   │   └── firebase.js            # Firebase Admin setup
│   ├── controllers/
│   │   └── authController.js      # All auth logic
│   ├── middleware/
│   │   ├── authMiddleware.js       # JWT protect + requireVerified
│   │   └── validationMiddleware.js # Input validation rules
│   ├── routes/
│   │   └── authRoutes.js          # Route definitions + rate limiting
│   ├── services/
│   │   ├── emailService.js         # Nodemailer + HTML email templates
│   │   └── smsService.js           # Twilio Verify OTP
│   └── utils/
│       ├── jwtUtils.js             # Sign / verify JWT tokens
│       └── otpUtils.js             # Generate / store / verify email OTPs
├── authService.js                 # React Native client service
├── .env.example                   # Environment variables template
└── package.json
```

---

## ⚡ Quick Start

### 1. Install dependencies
```bash
npm install
```

### 2. Configure environment variables
```bash
cp .env.example .env
# Then fill in all the values (see setup guide below)
```

### 3. Start the server
```bash
# Development (auto-restart)
npm run dev

# Production
npm start
```

---

## 🔧 Setup Guide

### Firebase
1. Go to [Firebase Console](https://console.firebase.google.com)
2. Create a project → **Firestore Database** → Start in production mode
3. **Project Settings → Service Accounts → Generate New Private Key**
4. Copy the values from the downloaded JSON into your `.env`

**Firestore Security Rules** (paste in Firebase Console → Firestore → Rules):
```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    // Users can only read their own profile
    match /users/{userId} {
      allow read: if request.auth != null && request.auth.uid == userId;
      allow write: if false; // All writes go through backend
    }
    // OTPs are backend-only
    match /otps/{docId} {
      allow read, write: if false;
    }
  }
}
```

### Twilio (SMS OTP)
1. Sign up at [twilio.com](https://twilio.com)
2. Go to **Verify → Services → Create new Service** (name it "PromoEarn")
3. Copy the **Service SID** → `TWILIO_VERIFY_SERVICE_SID`
4. Get **Account SID** and **Auth Token** from the dashboard

### Nodemailer (Gmail)
1. Enable **2-Factor Authentication** on your Gmail account
2. Go to **Google Account → Security → App Passwords**
3. Generate an app password for "Mail"
4. Use that as `SMTP_PASS` (not your actual Gmail password)

---

## 📡 API Endpoints

Base URL: `http://localhost:5000/api/v1/auth`

### Registration & Verification

| Method | Endpoint | Description | Rate Limit |
|--------|----------|-------------|------------|
| `POST` | `/register` | Create account | 10/15min |
| `POST` | `/verify-email` | Verify email OTP | 5/10min |
| `POST` | `/verify-phone` | Verify phone OTP | 5/10min |
| `POST` | `/resend-otp` | Resend OTP | 5/10min |

### Authentication

| Method | Endpoint | Description | Rate Limit |
|--------|----------|-------------|------------|
| `POST` | `/login` | Login with email OR phone | 10/15min |
| `POST` | `/refresh-token` | Get new access token | — |
| `POST` | `/logout` | Logout (clears client token) | — |
| `GET`  | `/me` | Get current user 🔒 | — |

### Password Reset

| Method | Endpoint | Description | Rate Limit |
|--------|----------|-------------|------------|
| `POST` | `/forgot-password` | Send reset OTP | 5/hour |
| `POST` | `/reset-password` | Reset with OTP | 5/hour |

🔒 = Requires `Authorization: Bearer <token>` header

---

## 📦 Request & Response Examples

### Register
```json
POST /api/v1/auth/register
{
  "firstName": "Amara",
  "lastName": "Okafor",
  "email": "amara@example.com",
  "phone": "+2348001234567",
  "password": "SecurePass123",
  "confirmPassword": "SecurePass123",
  "username": "amara_ok",
  "dob": "1998-05-14",
  "gender": "Female",
  "referralCode": "PE-ABC123"  // optional
}
```

### Login (email or phone — backend detects automatically)
```json
POST /api/v1/auth/login
{ "identifier": "amara@example.com", "password": "SecurePass123" }
// OR
{ "identifier": "+2348001234567", "password": "SecurePass123" }
```

### Response (login/verify)
```json
{
  "success": true,
  "message": "Login successful! 🚀",
  "data": {
    "accessToken": "eyJhbGci...",
    "refreshToken": "eyJhbGci...",
    "expiresIn": "7d",
    "user": {
      "uid": "uuid-here",
      "firstName": "Amara",
      "email": "amara@example.com",
      "phone": "+2348001234567",
      "emailVerified": true,
      "phoneVerified": false
    },
    "verificationWarnings": "Please verify your phone."
  }
}
```

---

## 🔒 Protecting Your Own Routes

```js
const { protect, requireVerified } = require('./middleware/authMiddleware');

// Require login
router.get('/dashboard', protect, (req, res) => {
  res.json({ user: req.user });
});

// Require login + verified email/phone
router.post('/tasks', protect, requireVerified, createTask);
```

---

## 📱 React Native Integration

Copy `authService.js` into your RN project:

```js
import AuthService from './services/authService';

// Register
await AuthService.register({ firstName, lastName, email, phone, password, confirmPassword, username, dob, gender });

// Login with email OR phone
await AuthService.login('amara@example.com', 'password123');
await AuthService.login('+2348001234567', 'password123');

// Verify
await AuthService.verifyEmail('amara@example.com', '123456');
await AuthService.verifyPhone('+2348001234567', '654321');

// Resend OTP
await AuthService.resendOtp('amara@example.com', 'email');
await AuthService.resendOtp('+2348001234567', 'phone');

// Password reset
await AuthService.forgotPassword('amara@example.com');
await AuthService.resetPassword('amara@example.com', '123456', 'NewPass123');

// Check session
const loggedIn = await AuthService.isLoggedIn();

// Logout
await AuthService.logout();
```

---

## 🛡️ Security Features

- **bcrypt** (cost 12) for password hashing
- **JWT** access tokens (7d) + refresh tokens (30d)
- **Rate limiting** on all auth endpoints
- **Helmet** security headers
- **OTP brute-force protection** (max 5 attempts → auto-delete)
- **OTP expiry** (configurable, default 10 minutes)
- **User enumeration protection** on forgot password
- **Input validation** on all endpoints
- Sensitive fields stripped from all responses

---

## 🗄️ Firestore Collections

| Collection | Document ID | Description |
|------------|-------------|-------------|
| `users` | `{uid}` | User profiles |
| `otps` | `{purpose}_{identifier}` | Email OTPs (auto-deleted on use/expiry) |
