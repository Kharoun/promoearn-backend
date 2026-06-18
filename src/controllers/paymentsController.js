const { createNotification } = require("./notificationsController");
const { getDb } = require("../config/firebase");
const { v4: uuidv4 } = require("uuid");
const https = require("https");
const { Resend } = require('resend');
const resend = new Resend(process.env.RESEND_API_KEY);
// ─── Constants ────────────────────────────────────────────────────────────────
const NGN_RATE         = 1500;
const REGISTRATION_FEE = 4500 / NGN_RATE;  // = $3.00
const WELCOME_BONUS    = 0;
const TASK_REWARD      = 0.17;
const REFERRAL_BONUS   = 1.33;
const MIN_WITHDRAWAL = 5010 / NGN_RATE;  // = $3.34
const WITHDRAWAL_FEE = 200 / NGN_RATE;  // ₦200 = ~$0.133
const PAYSTACK_SECRET  = process.env.PAYSTACK_SECRET_KEY;

// ─── Helper: call Paystack API ────────────────────────────────────────────────
const paystackRequest = (method, path, body) => {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: "api.paystack.co",
      port:     443,
      path,
      method,
      headers: {
        Authorization: `Bearer ${PAYSTACK_SECRET}`,
        "Content-Type": "application/json",
      },
    };
    const req = https.request(options, res => {
      let data = "";
      res.on("data", chunk => data += chunk);
      res.on("end", () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error("Invalid JSON from Paystack: " + data)); }
      });
    });
    req.on("error", reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
};

// ─── GET NIGERIAN BANKS LIST ──────────────────────────────────────────────────
// ─── GET NIGERIAN BANKS LIST (hardcoded — no Paystack API needed) ─────────────
exports.getBanks = async (req, res) => {
  const banks = [
    { id: 1,  name: "Access Bank",                     code: "044" },
    { id: 2,  name: "Citibank Nigeria",                code: "023" },
    { id: 3,  name: "Ecobank Nigeria",                 code: "050" },
    { id: 4,  name: "Fidelity Bank",                   code: "070" },
    { id: 5,  name: "First Bank of Nigeria",           code: "011" },
    { id: 6,  name: "First City Monument Bank (FCMB)", code: "214" },
    { id: 7,  name: "Globus Bank",                     code: "00103" },
    { id: 8,  name: "Guaranty Trust Bank (GTBank)",    code: "058" },
    { id: 9,  name: "Heritage Bank",                   code: "030" },
    { id: 10, name: "Jaiz Bank",                       code: "301" },
    { id: 11, name: "Keystone Bank",                   code: "082" },
    { id: 12, name: "Kuda Bank",                       code: "50211" },
    { id: 13, name: "Moniepoint MFB",                  code: "50515" },
    { id: 14, name: "OPay",                            code: "999992" },
    { id: 15, name: "Palmpay",                         code: "999991" },
    { id: 16, name: "Polaris Bank",                    code: "076" },
    { id: 17, name: "Providus Bank",                   code: "101" },
    { id: 18, name: "Stanbic IBTC Bank",               code: "221" },
    { id: 19, name: "Standard Chartered Bank",         code: "068" },
    { id: 20, name: "Sterling Bank",                   code: "232" },
    { id: 21, name: "Suntrust Bank",                   code: "100" },
    { id: 22, name: "Titan Trust Bank",                code: "102" },
    { id: 23, name: "Union Bank of Nigeria",           code: "032" },
    { id: 24, name: "United Bank for Africa (UBA)",    code: "033" },
    { id: 25, name: "Unity Bank",                      code: "215" },
    { id: 26, name: "VFD Microfinance Bank",           code: "566" },
    { id: 27, name: "Wema Bank",                       code: "035" },
    { id: 28, name: "Zenith Bank",                     code: "057" },
  ].sort((a, b) => a.name.localeCompare(b.name));

  return res.status(200).json({ success: true, data: { banks } });
};
// ─── VERIFY ACCOUNT NUMBER ────────────────────────────────────────────────────
// ─── VERIFY ACCOUNT NUMBER (manual — Paystack disabled) ──────────────────────
exports.verifyAccount = async (req, res) => {
  const { accountNumber, bankCode } = req.body;
  if (!accountNumber || !bankCode) {
    return res.status(400).json({ success: false, message: "Account number and bank code are required." });
  }
  // Return the account number as-is — admin verifies on payout
  return res.status(200).json({
    success: true,
    data: {
      accountName:   "— Verify on payout —",
      accountNumber: accountNumber,
    },
  });
};

// ─── REQUEST WITHDRAWAL (Paystack Transfer) ───────────────────────────────────
exports.requestWithdrawal = async (req, res) => {
  try {
    const { amount, accountNumber, bankCode, bankName, accountName } = req.body;
    const db  = getDb();
    const uid = req.user.uid;

    // ── 1. Validate inputs ──────────────────────────────────────────────────
    if (!amount || parseFloat(amount) < MIN_WITHDRAWAL) {
      return res.status(400).json({
        success: false,
        message: `Minimum withdrawal is $${MIN_WITHDRAWAL.toFixed(2)}.`,
      });
    }
    if (!accountNumber || !bankName || !accountName) {
      return res.status(400).json({ success: false, message: "All bank details are required." });
    }

    // ── 2. Load user and check balance ──────────────────────────────────────
    const userDoc = await db.collection("users").doc(uid).get();
    if (!userDoc.exists) {
      return res.status(404).json({ success: false, message: "User not found." });
    }
    const user = userDoc.data();

    if ((user.balance || 0) < parseFloat(amount)) {
      return res.status(400).json({ success: false, message: "Insufficient balance." });
    }

    const withdrawAmt    = parseFloat(amount);
    const amountAfterFee = withdrawAmt - WITHDRAWAL_FEE;
    const amountNGN      = amountAfterFee * NGN_RATE;

    // ── 3. Deduct balance immediately (hold the funds) ──────────────────────
    await db.collection("users").doc(uid).update({
      balance:   (user.balance || 0) - withdrawAmt,
      updatedAt: new Date(),
    });

    // ── 4. Save withdrawal request as "pending" — no Paystack transfer yet ──
    const paymentRef = await db.collection("payments").add({
      userId:        uid,
      username:      user.username,
      email:         user.email,
      amount:        withdrawAmt,
      amountAfterFee,
      amountNGN,
      accountNumber,
      bankCode:      bankCode || "",
      bankName,
      accountName,
      status:        "pending",   // ← admin must approve before transfer fires
      createdAt:     new Date(),
      updatedAt:     new Date(),
    });

    // ── 5. Log transaction ──────────────────────────────────────────────────
    await db.collection("transactions").add({
      userId:      uid,
      type:        "withdrawal",
      description: `Withdrawal request to ${bankName} - ${accountName}`,
      amount:      -withdrawAmt,
      status:      "pending",
      paymentId:   paymentRef.id,
      createdAt:   new Date(),
    });

    // ── 6. Notify user ──────────────────────────────────────────────────────
    await createNotification(uid, {
      title: "💸 Withdrawal Request Received",
      body:  `Your withdrawal of $${amountAfterFee.toFixed(2)} (₦${amountNGN.toLocaleString()}) to ${bankName} is being reviewed. You'll receive it within 24 hours.`,
      type:  "paymentAlerts",
    });

    return res.status(201).json({
      success: true,
      message: `Withdrawal request submitted! You'll receive $${amountAfterFee.toFixed(2)} (₦${amountNGN.toLocaleString()}) in your ${bankName} account within 24 hours.`,
      data: { paymentId: paymentRef.id, status: "pending" },
    });

  } catch (err) {
    console.error("Withdrawal error:", err);
    return res.status(500).json({ success: false, message: "Failed to submit withdrawal request. Please try again." });
  }
};

// ─── INITIALIZE PAYMENT (Paystack checkout) ───────────────────────────────────
exports.createCheckout = async (req, res) => {
  try {
    const { userId, email } = req.body;
    const db = getDb();

    const userDoc = await db.collection("users").doc(userId).get();
    if (!userDoc.exists) {
      return res.status(404).json({ success: false, message: "User not found." });
    }

    const user = userDoc.data();
    if (user.isActivated) {
      return res.status(400).json({ success: false, message: "Account already activated." });
    }

    const amountInKobo = 4500 * 100; // 450000 kobo = ₦4,500 (~$3)

    const response = await paystackRequest("POST", "/transaction/initialize", {
      email,
      amount:   amountInKobo,
      currency: "NGN",
      reference: `PE-${userId}-${Date.now()}`,

      // ── Split payment config ──────────────────────────────
     split: {
  type: "percentage",
  bearer_type: "account",
  bearer_subaccount: "ACCT_w3z0tqg2smqk1h9",
  subaccounts: [
    {
      subaccount: "ACCT_w3z0tqg2smqk1h9",
      share: 45,
    },
    {
      subaccount: "ACCT_kauokc340c1dbv7",
      share: 45,
    },
  ],
},
      // ─────────────────────────────────────────────────────

      callback_url: `${process.env.CLIENT_URL}/payment-success`,
      metadata: {
        userId,
        custom_fields: [
          { display_name: "Product",      variable_name: "product",    value: "PromoEarn Registration" },
          { display_name: "Amount (USD)", variable_name: "amount_usd", value: `$${REGISTRATION_FEE}` },
        ],
      },
    });

    if (!response.status) {
      console.error("Paystack error:", JSON.stringify(response));
      return res.status(400).json({ success: false, message: response.message || "Failed to initialize payment." });
    }
    return res.status(200).json({
      success:   true,
      url:       response.data.authorization_url,
      reference: response.data.reference,
    });
  } catch (err) {
    console.error("Create checkout error:", err);
    return res.status(500).json({ success: false, message: "Failed to create payment." });
  }
};
// ─── VERIFY PAYMENT & ACTIVATE ACCOUNT ───────────────────────────────────────
exports.verifyPayment = async (req, res) => {
  try {
    const { reference } = req.body;
    const db = getDb();

    // 1. Verify with Paystack
    const response = await paystackRequest("GET", `/transaction/verify/${encodeURIComponent(reference)}`);

    if (!response.status || response.data.status !== "success") {
      return res.status(400).json({ success: false, message: "Payment not completed." });
    }

    const userId = response.data.metadata?.userId;
    if (!userId) {
      return res.status(400).json({ success: false, message: "Invalid payment metadata." });
    }

    // 2. Load user
    const userDoc = await db.collection("users").doc(userId).get();
    if (!userDoc.exists) {
      return res.status(404).json({ success: false, message: "User not found." });
    }
    const user = { uid: userDoc.id, ...userDoc.data() };

    // 3. Prevent double activation
    if (user.isActivated) {
      return res.status(200).json({ success: true, message: "Account already activated." });
    }

    // 4. Activate + welcome bonus
    await db.collection("users").doc(userId).update({
      isActivated: true,
      balance:     (user.balance || 0) + WELCOME_BONUS,
      totalEarned: (user.totalEarned || 0) + WELCOME_BONUS,
      updatedAt:   new Date(),
    });

    // 5. Log welcome bonus
    await db.collection("transactions").add({
      userId,
      type:        "bonus",
      description: "Welcome bonus",
      amount:      WELCOME_BONUS,
      status:      "completed",
      createdAt:   new Date(),
    });

    // 6. Log registration fee
    await db.collection("transactions").add({
      userId,
      type:              "registration",
      description:       "Registration fee",
      amount:            -REGISTRATION_FEE,
      status:            "completed",
      paystackReference: reference,
      createdAt:         new Date(),
    });

    // 7. Referral bonus
    if (user.referredBy) {
      const referrerDoc = await db.collection("users").doc(user.referredBy).get();
      if (referrerDoc.exists) {
        const referrer = referrerDoc.data();
        await db.collection("users").doc(user.referredBy).update({
          balance:        (referrer.balance       || 0) + REFERRAL_BONUS,
          totalEarned:    (referrer.totalEarned   || 0) + REFERRAL_BONUS,
          referralsCount: (referrer.referralsCount || 0) + 1,
          updatedAt:      new Date(),
        });
        await db.collection("transactions").add({
          userId:      user.referredBy,
          type:        "referral",
          description: `Referral bonus from @${user.username}`,
          amount:      REFERRAL_BONUS,
          status:      "completed",
          createdAt:   new Date(),
        });
      }
    }

    // 8. Notifications
    await createNotification(userId, {
      title: "🎉 Account Activated!",
      body:  `Welcome to PromoEarn! Your $${WELCOME_BONUS.toFixed(2)} welcome bonus has been added.`,
      type:  "paymentAlerts",
    });

    if (user.referredBy) {
      await createNotification(user.referredBy, {
        title: "💰 Referral Bonus Earned!",
        body:  `@${user.username} just activated their account. $${REFERRAL_BONUS.toFixed(2)} has been added to your balance!`,
        type:  "referralAlerts",
      });
    }

    return res.status(200).json({
      success: true,
      message: "Account activated! Welcome bonus added. 🎉",
      data:    { balance: (user.balance || 0) + WELCOME_BONUS },
    });

  } catch (err) {
    console.error("Verify payment error:", err);
    return res.status(500).json({ success: false, message: "Failed to verify payment." });
  }
};

// ─── GET USER TRANSACTIONS ────────────────────────────────────────────────────
exports.getTransactions = async (req, res) => {
  try {
    const db  = getDb();
    const uid = req.user.uid;

    const snap = await db.collection("transactions")
      .where("userId", "==", uid)
      .get();

    const transactions = snap.docs
      .map(doc => ({ id: doc.id, ...doc.data() }))
      .sort((a, b) => (b.createdAt?._seconds || 0) - (a.createdAt?._seconds || 0));

    return res.status(200).json({ success: true, data: { transactions } });
  } catch (err) {
    console.error("Get transactions error:", err);
    return res.status(500).json({ success: false, message: "Failed to fetch transactions." });
  }
};

// ─── PAYSTACK WEBHOOK ─────────────────────────────────────────────────────────
exports.paystackWebhook = async (req, res) => {
  try {
    const crypto = require("crypto");
    const secret = process.env.PAYSTACK_WEBHOOK_SECRET || PAYSTACK_SECRET;

    const hash = crypto
      .createHmac("sha512", secret)
      .update(req.body)
      .digest("hex");

    if (hash !== req.headers["x-paystack-signature"]) {
      return res.status(401).send("Invalid signature");
    }

    // Respond 200 immediately so Paystack doesn't retry
    res.status(200).json({ received: true });
    const { event, data } = JSON.parse(req.body.toString());
    const db = getDb();

    // ── charge.success: activate account if not yet activated ──────────────
    if (event === "charge.success") {
      const userId = data.metadata?.userId;
      if (!userId) return;

      const userDoc = await db.collection("users").doc(userId).get();
      if (!userDoc.exists || userDoc.data().isActivated) return;

      const user = userDoc.data();

      await db.collection("users").doc(userId).update({
        isActivated: true,
        balance:     (user.balance || 0) + WELCOME_BONUS,
        totalEarned: (user.totalEarned || 0) + WELCOME_BONUS,
        updatedAt:   new Date(),
      });

      await db.collection("transactions").add({
        userId,
        type:        "bonus",
        description: "Welcome bonus (webhook)",
        amount:      WELCOME_BONUS,
        status:      "completed",
        createdAt:   new Date(),
      });

      if (user.referredBy) {
        const referrerDoc = await db.collection("users").doc(user.referredBy).get();
        if (referrerDoc.exists) {
          const referrer = referrerDoc.data();
          await db.collection("users").doc(user.referredBy).update({
            balance:        (referrer.balance       || 0) + REFERRAL_BONUS,
            totalEarned:    (referrer.totalEarned   || 0) + REFERRAL_BONUS,
            referralsCount: (referrer.referralsCount || 0) + 1,
            updatedAt:      new Date(),
          });
        }
      }

      await createNotification(userId, {
        title: "🎉 Account Activated!",
        body:  "Account activated! Complete the available tasks to start earning.",
        type:  "paymentAlerts",
      });

      console.log(`✅ Webhook: User ${userId} activated`);
    }

    // ── transfer.success: mark withdrawal completed ─────────────────────────
    if (event === "transfer.success") {
      const transferCode = data.transfer_code;
      if (!transferCode) return;

      const snap = await db.collection("payments")
        .where("transferCode", "==", transferCode)
        .limit(1)
        .get();

      if (!snap.empty) {
        await snap.docs[0].ref.update({ status: "completed", updatedAt: new Date() });
        await db.collection("transactions")
          .where("transferCode", "==", transferCode)
          .get()
          .then(txSnap => {
            txSnap.docs.forEach(doc => doc.ref.update({ status: "completed" }));
          });
        console.log(`✅ Webhook: Transfer ${transferCode} completed`);
      }
    }

    // ── transfer.failed: refund user balance ────────────────────────────────
    if (event === "transfer.failed" || event === "transfer.reversed") {
      const transferCode = data.transfer_code;
      if (!transferCode) return;

      const snap = await db.collection("payments")
        .where("transferCode", "==", transferCode)
        .limit(1)
        .get();

      if (!snap.empty) {
        const payment = snap.docs[0].data();
        await snap.docs[0].ref.update({ status: "failed", updatedAt: new Date() });

        // Refund the user
        const userDoc = await db.collection("users").doc(payment.userId).get();
        if (userDoc.exists) {
          await db.collection("users").doc(payment.userId).update({
            balance:   (userDoc.data().balance || 0) + payment.amount,
            updatedAt: new Date(),
          });
          await db.collection("transactions").add({
            userId:      payment.userId,
            type:        "refund",
            description: `Withdrawal refund — transfer failed`,
            amount:      payment.amount,
            status:      "completed",
            createdAt:   new Date(),
          });
          await createNotification(payment.userId, {
            title: "⚠️ Withdrawal Failed",
            body:  `Your withdrawal of $${payment.amount.toFixed(2)} could not be processed. The amount has been refunded to your balance.`,
            type:  "paymentAlerts",
          });
        }
        console.log(`⚠️ Webhook: Transfer ${transferCode} failed — balance refunded`);
      }
    }

  } catch (err) {
    console.error("Webhook error:", err);
  }
};
// ─── VALIDATE REACTIVATION TOKEN ─────────────────────────────────────────────
exports.validateReactivationToken = async (req, res) => {
  try {
    const { token, email } = req.query;
    const db     = getDb();
    const crypto = require('crypto');

    if (!token || !email) {
      return res.status(400).json({ success: false, message: 'Invalid link.' });
    }

    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');

    const snap = await db.collection('users')
      .where('email', '==', email.toLowerCase())
      .limit(1).get();

    if (snap.empty) {
      return res.status(404).json({ success: false, message: 'Account not found.' });
    }

    const user = snap.docs[0].data();
    const uid  = snap.docs[0].id;

    if (user.reactivationToken !== tokenHash) {
      return res.status(400).json({ success: false, message: 'Invalid or already used link.' });
    }

    const expiry = user.reactivationTokenExpiry?._seconds
      ? new Date(user.reactivationTokenExpiry._seconds * 1000)
      : new Date(user.reactivationTokenExpiry);

    if (new Date() > expiry) {
      return res.status(400).json({ success: false, message: 'This link has expired. Please contact support.' });
    }

    if (!user.isBanned) {
      return res.status(400).json({ success: false, message: 'Account is already active.' });
    }

    return res.status(200).json({
      success: true,
      data: { uid, email: user.email, firstName: user.firstName },
    });
  } catch (err) {
    console.error('Validate reactivation token error:', err);
    return res.status(500).json({ success: false, message: 'Failed to validate link.' });
  }
};

// ─── REQUEST REACTIVATION (manual — Paystack disabled) ────────────────────────
exports.requestReactivation = async (req, res) => {
  try {
    const { token, email, senderName } = req.body;
    const db     = getDb();
    const crypto = require('crypto');

    if (!token || !email) {
      return res.status(400).json({ success: false, message: 'Invalid request.' });
    }

    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');

    const snap = await db.collection('users')
      .where('email', '==', email.toLowerCase())
      .limit(1).get();

    if (snap.empty) return res.status(404).json({ success: false, message: 'Account not found.' });

    const user = snap.docs[0].data();
    const uid  = snap.docs[0].id;

    if (user.reactivationToken !== tokenHash) {
      return res.status(400).json({ success: false, message: 'Invalid or expired link.' });
    }
    if (!user.isBanned) {
      return res.status(400).json({ success: false, message: 'Account is already active.' });
    }

    // Prevent duplicate pending requests
    const existing = await db.collection('reactivations')
      .where('userId', '==', uid).where('status', '==', 'pending').limit(1).get();
    if (!existing.empty) {
      return res.status(400).json({ success: false, message: 'You already have a pending reactivation request.' });
    }

    // Save reactivation request
    await db.collection('reactivations').add({
      userId:     uid,
      email:      user.email,
      username:   user.username   || '',
      firstName:  user.firstName  || '',
      senderName: senderName      || '',
      status:     'pending',
      createdAt:  new Date(),
      updatedAt:  new Date(),
    });

    // Notify admin
    const adminEmail = process.env.ADMIN_EMAIL || 'contact.promoearn@gmail.com';
    await resend.emails.send({
      from:    'PromoEarn <noreply@promoearnapp.com>',
      to:      adminEmail,
      subject: `💳 Reactivation Request — ${user.firstName || user.email}`,
      html: `
        <div style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:20px">
          <div style="background:#1A56DB;padding:20px;border-radius:12px 12px 0 0;text-align:center">
            <h2 style="color:#fff;margin:0">PromoEarn Admin</h2>
          </div>
          <div style="background:#fff;padding:24px;border:1px solid #E2E8F0;border-top:none;border-radius:0 0 12px 12px">
            <p style="font-size:15px;color:#0F172A;font-weight:700;">New Reactivation Request</p>
            <table style="width:100%;border-collapse:collapse;font-size:14px;">
              <tr><td style="padding:8px 0;color:#64748B;">User</td><td style="font-weight:700;">${user.firstName || ''} (@${user.username || user.email})</td></tr>
              <tr><td style="padding:8px 0;color:#64748B;">Email</td><td>${user.email}</td></tr>
              <tr><td style="padding:8px 0;color:#64748B;">Sender Name</td><td style="font-weight:700;color:#1A56DB;">${senderName || '(not provided)'}</td></tr>
              <tr><td style="padding:8px 0;color:#64748B;">Amount</td><td style="font-weight:700;color:#16A34A;">₦1,000</td></tr>
            </table>
            <p style="font-size:13px;color:#64748B;margin-top:16px;">Go to the admin panel → Reactivations to approve or reject.</p>
          </div>
        </div>
      `,
    });

    return res.status(200).json({
      success: true,
      message: 'Request submitted! Your account will be reviewed within 24 hours.',
    });
  } catch (err) {
    console.error('Request reactivation error:', err);
    return res.status(500).json({ success: false, message: 'Failed to submit reactivation request.' });
  }
};
// ─── POST /api/v1/payments/manual-activation ─────────────────────────────────
// REPLACE the existing exports.manualActivation in paymentsController.js with this.
// NOTE: resend is already initialized at the top of paymentsController.js — no extra import needed.
exports.manualActivation = async (req, res) => {
    try {
      const { userId, email, senderName } = req.body;
      const db = getDb();
  
      if (!userId || !senderName || !senderName.trim()) {
        return res.status(400).json({ success: false, message: "Sender's name is required." });
      }
  
      const cleanSenderName = senderName.trim();
      const submittedAt     = new Date().toLocaleString("en-US", {
        timeZone: "Africa/Lagos",
        month: "short", day: "numeric", year: "numeric",
        hour: "2-digit", minute: "2-digit",
      });
  
      // 1. Save the pending activation request for admin to review
      await db.collection("pendingActivations").add({
        userId,
        email:      email || "",
        senderName: cleanSenderName,
        status:     "pending",
        createdAt:  new Date(),
      });
  
      // 2. Firestore admin notification (for in-app admin panel badge)
      await db.collection("adminNotifications").add({
        type:       "manual_activation",
        userId,
        email,
        senderName: cleanSenderName,
        message:    `New activation request from ${email}. Sender name: ${cleanSenderName}`,
        createdAt:  new Date(),
        read:       false,
      });
  
      // 3. Email the admin immediately via Resend
      const adminEmail = process.env.ADMIN_EMAIL || "contact.promoearn@gmail.com";
      await resend.emails.send({
        from:    "PromoEarn Alerts <noreply@promoearnapp.com>",
        to:      adminEmail,
        subject: "🔔 New Activation Request — Action Required",
        html: `
          <div style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:20px">
            <div style="background:#1A56DB;padding:20px;border-radius:12px 12px 0 0;text-align:center">
              <h2 style="color:#fff;margin:0">PromoEarn Admin Alert</h2>
            </div>
            <div style="background:#fff;padding:28px;border:1px solid #E2E8F0;border-top:none;border-radius:0 0 12px 12px">
              <p style="font-size:15px;color:#0F172A;margin-top:0">
                A user has submitted a manual bank transfer for account activation.
              </p>
  
              <table style="width:100%;border-collapse:collapse;margin:20px 0;font-size:14px">
                <tr style="background:#F8FAFF">
                  <td style="padding:10px 14px;color:#64748B;border:1px solid #E2E8F0;width:35%">User Email</td>
                  <td style="padding:10px 14px;color:#0F172A;font-weight:700;border:1px solid #E2E8F0">${email}</td>
                </tr>
                <tr>
                  <td style="padding:10px 14px;color:#64748B;border:1px solid #E2E8F0">Sender's Name</td>
                  <td style="padding:10px 14px;color:#1A56DB;font-weight:700;border:1px solid #E2E8F0">${cleanSenderName}</td>
                </tr>
                <tr style="background:#F8FAFF">
                  <td style="padding:10px 14px;color:#64748B;border:1px solid #E2E8F0">Amount</td>
                  <td style="padding:10px 14px;color:#0F172A;font-weight:700;border:1px solid #E2E8F0">₦4,500</td>
                </tr>
                <tr>
                  <td style="padding:10px 14px;color:#64748B;border:1px solid #E2E8F0">Submitted At</td>
                  <td style="padding:10px 14px;color:#0F172A;border:1px solid #E2E8F0">${submittedAt} (WAT)</td>
                </tr>
              </table>
  
              <div style="background:#FFFBEB;border-left:4px solid #F59E0B;padding:14px;border-radius:0 8px 8px 0;margin:20px 0">
                <p style="margin:0;color:#92600A;font-weight:600;font-size:13px">
                  ⚠️ Action required: Open your bank app, search for a ₦4,500 transfer from <strong>${cleanSenderName}</strong>, confirm it, then approve in the admin panel.
                </p>
              </div>
  
              <div style="text-align:center;margin:24px 0">
                <a href="https://admin.promoearnapp.com"
                   style="display:inline-block;background:#1A56DB;color:#fff;padding:14px 32px;border-radius:10px;text-decoration:none;font-weight:700;font-size:15px">
                  👉 Open Admin Panel
                </a>
              </div>
  
              <hr style="border:none;border-top:1px solid #E2E8F0;margin:24px 0"/>
              <p style="font-size:12px;color:#94A3B8;text-align:center;margin:0">
                © ${new Date().getFullYear()} PromoEarn. This is an automated alert — do not reply to this email.
              </p>
            </div>
          </div>
        `,
      });
  
      return res.status(200).json({
        success: true,
        message: "Activation request received. Your account will be activated within 1–6 hours.",
      });
    } catch (err) {
      console.error("Manual activation error:", err);
      return res.status(500).json({ success: false, message: "Server error." });
    }
  };
  // ─── PAYSTACK WEBHOOK ─────────────────────────────────────────────────────────
exports.paystackWebhook = async (req, res) => {
  // TODO: add Paystack signature verification here
  return res.sendStatus(200);
};

// ─── GET TRANSACTIONS ─────────────────────────────────────────────────────────
exports.getTransactions = async (req, res) => {
  try {
    const db  = getDb();
    const uid = req.user.uid;
    const snap = await db.collection("transactions")
      .where("userId", "==", uid)
      .orderBy("createdAt", "desc")
      .get();
    const transactions = snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    return res.json({ success: true, data: { transactions } });
  } catch (err) {
    console.error("Get transactions error:", err);
    return res.status(500).json({ success: false, message: "Failed to fetch transactions." });
  }
};

// ─── REACTIVATION ─────────────────────────────────────────────────────────────
exports.validateReactivationToken = async (req, res) => {
  return res.status(501).json({ success: false, message: "Not implemented yet." });
};

exports.createReactivationCheckout = async (req, res) => {
  return res.status(501).json({ success: false, message: "Not implemented yet." });
};

exports.verifyReactivation = async (req, res) => {
  return res.status(501).json({ success: false, message: "Not implemented yet." });
};

// ─── MANUAL ACTIVATION ────────────────────────────────────────────────────────
exports.manualActivation = async (req, res) => {
  return res.status(501).json({ success: false, message: "Not implemented yet." });
};
  