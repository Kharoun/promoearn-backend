const { createNotification } = require("./notificationsController");
const { getDb } = require("../config/firebase");
const { v4: uuidv4 } = require("uuid");
const https = require("https");
const { flw } = require("../utils/flutterwave");
const { Resend } = require('resend');
const resend = new Resend(process.env.RESEND_API_KEY);
// ─── Constants ────────────────────────────────────────────────────────────────
const NGN_RATE         = 1500;
const REGISTRATION_FEE = 4500 / NGN_RATE;  // = $3.00
const WELCOME_BONUS    = 0;
const TASK_REWARD      = 0.17;
const REFERRAL_BONUS   = 1.33;
// const MIN_WITHDRAWAL = 5010 / NGN_RATE;  // = $3.34
const MIN_WITHDRAWAL = 200 / NGN_RATE;  // ~₦200, just for testing
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
exports.getBanks = async (req, res) => {
  try {
    const { data } = await flw.get("/banks/NG");
    if (data.status !== "success") throw new Error("Bank list fetch failed");
    const banks = data.data
      .map(b => ({ id: b.id, name: b.name, code: b.code }))
      .sort((a, b) => a.name.localeCompare(b.name));
    return res.status(200).json({ success: true, data: { banks } });
  } catch (err) {
    console.error("Get banks error:", err.response?.data || err.message);
    return res.status(500).json({ success: false, message: "Failed to fetch banks." });
  }
};

exports.verifyAccount = async (req, res) => {
  try {
    const { accountNumber, bankCode } = req.body;
    if (!accountNumber || !bankCode) {
      return res.status(400).json({ success: false, message: "Account number and bank code are required." });
    }
    const { data } = await flw.post("/accounts/resolve", {
      account_number: accountNumber,
      account_bank: bankCode,
    });
    if (data.status !== "success") {
      return res.status(400).json({ success: false, message: data.message || "Could not verify account." });
    }
    return res.status(200).json({
      success: true,
      data: { accountName: data.data.account_name, accountNumber },
    });
  } catch (err) {
    console.error("Verify account error:", err.response?.data || err.message);
    return res.status(200).json({
      success: true,
      data: { accountName: "— Verify on payout —", accountNumber: req.body.accountNumber },
    });
  }
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

    const tx_ref = `PE-ACT-${userId}-${Date.now()}`;

    const { data } = await flw.post("/payments", {
      tx_ref,
      amount: 100,
      currency: "NGN",
      redirect_url: `${process.env.CLIENT_URL}/payment-success`,
      customer: { email, name: `${user.firstName || ""} ${user.lastName || ""}`.trim() || email },
      customizations: { title: "PromoEarn Activation", description: "One-time account activation fee" },
      meta: { userId, purpose: "activation", tx_ref },
    });

    if (data.status !== "success") {
      console.error("Flutterwave init error:", data);
      return res.status(400).json({ success: false, message: data.message || "Failed to initialize payment." });
    }

    await db.collection("users").doc(userId).update({ pendingActivationRef: tx_ref, updatedAt: new Date() });

    return res.status(200).json({ success: true, url: data.data.link, reference: tx_ref });
  } catch (err) {
    console.error("Create checkout error:", err.response?.data || err.message);
    return res.status(500).json({ success: false, message: "Failed to create payment." });
  }
};

const activateUserFromPayment = async (db, userId) => {
  const userDoc = await db.collection("users").doc(userId).get();
  if (!userDoc.exists) throw new Error("User not found");
  const user = { uid: userDoc.id, ...userDoc.data() };
  if (user.isActivated) return user;

  await db.collection("users").doc(userId).update({
    isActivated: true,
    balance: (user.balance || 0) + WELCOME_BONUS,
    totalEarned: (user.totalEarned || 0) + WELCOME_BONUS,
    pendingActivationRef: null,
    updatedAt: new Date(),
  });

  await db.collection("transactions").add({
    userId, type: "bonus", description: "Welcome bonus",
    amount: WELCOME_BONUS, status: "completed", createdAt: new Date(),
  });
  await db.collection("transactions").add({
    userId, type: "registration", description: "Registration fee (Flutterwave)",
    amount: -REGISTRATION_FEE, status: "completed", createdAt: new Date(),
  });

  if (user.referredBy) {
    const referrerDoc = await db.collection("users").doc(user.referredBy).get();
    if (referrerDoc.exists) {
      const referrer = referrerDoc.data();
      await db.collection("users").doc(user.referredBy).update({
        balance: (referrer.balance || 0) + REFERRAL_BONUS,
        totalEarned: (referrer.totalEarned || 0) + REFERRAL_BONUS,
        referralsCount: (referrer.referralsCount || 0) + 1,
        updatedAt: new Date(),
      });
      await db.collection("transactions").add({
        userId: user.referredBy, type: "referral",
        description: `Referral bonus from @${user.username}`,
        amount: REFERRAL_BONUS, status: "completed", createdAt: new Date(),
      });
      await createNotification(user.referredBy, {
        title: "💰 Referral Bonus Earned!",
        body: `@${user.username} just activated their account. $${REFERRAL_BONUS.toFixed(2)} has been added!`,
        type: "referralAlerts",
      });
    }
  }

  await createNotification(userId, {
    title: "🎉 Account Activated!",
    body: `Welcome to PromoEarn! Your $${WELCOME_BONUS.toFixed(2)} welcome bonus has been added.`,
    type: "paymentAlerts",
  });

  return { ...user, balance: (user.balance || 0) + WELCOME_BONUS };
};

const settleFlutterwaveTransaction = async (db, txData) => {
  const meta = txData.meta || {};
  if (meta.purpose === "activation" && meta.userId) {
    return { purpose: "activation", result: await activateUserFromPayment(db, meta.userId) };
  }
  if (meta.purpose === "campaign" && meta.campaignId) {
    const campaignRef = db.collection("campaigns").doc(meta.campaignId);
    const campaignDoc = await campaignRef.get();
    if (campaignDoc.exists && campaignDoc.data().paymentStatus !== "paid") {
      await campaignRef.update({
        paymentStatus: "paid", status: "paid_pending_review",
        paidAt: new Date(), updatedAt: new Date(),
      });
    }
    return { purpose: "campaign", campaignId: meta.campaignId };
  }
  throw new Error("Unrecognized payment purpose in Flutterwave meta");
};
// ─── VERIFY PAYMENT & ACTIVATE ACCOUNT ───────────────────────────────────────
exports.verifyPayment = async (req, res) => {
  try {
    const { reference } = req.body;
    const db = getDb();

    const { data: verifyRes } = await flw.get(
      `/transactions/verify_by_reference?tx_ref=${encodeURIComponent(reference)}`
    );
    if (verifyRes.status !== "success" || verifyRes.data.status !== "successful") {
      return res.status(400).json({ success: false, message: "Payment not completed yet." });
    }

    const outcome = await settleFlutterwaveTransaction(db, verifyRes.data);

    if (outcome.purpose === "activation") {
      return res.status(200).json({
        success: true,
        message: "Account activated! 🎉",
        data: { balance: outcome.result.balance },
      });
    }
    return res.status(200).json({
      success: true,
      message: "Payment confirmed. Your campaign is now in review.",
      data: outcome,
    });
  } catch (err) {
    console.error("Verify payment error:", err.response?.data || err.message);
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

exports.flutterwaveWebhook = async (req, res) => {
  try {
    const signature = req.headers["verif-hash"];
    if (!signature || signature !== process.env.FLW_WEBHOOK_HASH) {
      return res.status(401).send("Invalid signature");
    }
    res.status(200).json({ received: true });

    const event = req.body;
    const db = getDb();

    if (event.event === "charge.completed" && event.data?.status === "successful") {
      const { data: verifyRes } = await flw.get(`/transactions/${event.data.id}/verify`);
      if (verifyRes.data?.status === "successful") {
        try {
          await settleFlutterwaveTransaction(db, verifyRes.data);
          console.log("✅ FLW webhook settled charge", event.data.id);
        } catch (e) {
          console.error("Settle error:", e.message);
        }
      }
    }

    if (event.event === "transfer.completed") {
      const txRef = event.data?.reference;
      if (!txRef) return;

      const snap = await db.collection("payments").where("transferRef", "==", txRef).limit(1).get();
      if (snap.empty) return;
      const paymentDoc = snap.docs[0];
      const payment = paymentDoc.data();

      if (event.data.status === "SUCCESSFUL") {
        await paymentDoc.ref.update({ status: "completed", updatedAt: new Date() });
        const txSnap = await db.collection("transactions").where("paymentId", "==", paymentDoc.id).limit(1).get();
        txSnap.docs.forEach(d => d.ref.update({ status: "completed" }));

        await createNotification(payment.userId, {
          title: "💸 Withdrawal Processed!",
          body: `Your withdrawal of $${payment.amountAfterFee?.toFixed(2)} (₦${Math.round(payment.amountNGN || 0).toLocaleString()}) to ${payment.bankName} has been sent.`,
          type: "paymentAlerts",
        });
        console.log(`✅ Transfer ${txRef} completed`);
      } else {
        await paymentDoc.ref.update({ status: "failed", updatedAt: new Date() });
        const userDoc = await db.collection("users").doc(payment.userId).get();
        if (userDoc.exists) {
          await db.collection("users").doc(payment.userId).update({
            balance: (userDoc.data().balance || 0) + payment.amount,
            updatedAt: new Date(),
          });
          await db.collection("transactions").add({
            userId: payment.userId, type: "refund",
            description: "Withdrawal refund — transfer failed",
            amount: payment.amount, status: "completed", createdAt: new Date(),
          });
          await createNotification(payment.userId, {
            title: "⚠️ Withdrawal Failed",
            body: `Your withdrawal of $${payment.amount.toFixed(2)} could not be processed. It has been refunded to your balance.`,
            type: "paymentAlerts",
          });
        }
        console.log(`⚠️ Transfer ${txRef} failed — refunded`);
      }
    }
  } catch (err) {
    console.error("Flutterwave webhook error:", err.response?.data || err.message);
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
  try {
    const { token, email } = req.query;
    if (!token || !email) {
      return res.status(400).json({ success: false, message: "Missing token or email." });
    }

    const crypto    = require('crypto');
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');

    const db = getDb();

    // Token is stored on the user document, not a separate collection
    const snap = await db.collection('users')
      .where('email', '==', email)
      .where('reactivationToken', '==', tokenHash)
      .limit(1)
      .get();

    if (snap.empty) {
      return res.status(404).json({ success: false, message: "Invalid or expired reactivation link." });
    }

    const userDoc = snap.docs[0];
    const user    = userDoc.data();

    // Check expiry
    const expiry = user.reactivationTokenExpiry?.toDate?.()
      || new Date(user.reactivationTokenExpiry);

    if (new Date() > expiry) {
      return res.status(400).json({ success: false, message: "This reactivation link has expired. Please contact support." });
    }

    if (!user.isBanned) {
      return res.status(400).json({ success: false, message: "Your account is not currently suspended." });
    }

    return res.json({
      success: true,
      data: { firstName: user.firstName || 'there', userId: userDoc.id },
    });

  } catch (err) {
    console.error("validateReactivationToken error:", err);
    return res.status(500).json({ success: false, message: "Server error." });
  }
};

exports.createReactivationCheckout = async (req, res) => {
  return res.status(501).json({ success: false, message: "Not implemented yet." });
};

exports.verifyReactivation = async (req, res) => {
  return res.status(501).json({ success: false, message: "Not implemented yet." });
};

// ─── MANUAL ACTIVATION ────────────────────────────────────────────────────────

exports.requestReactivation = async (req, res) => {
  try {
    const { token, email, senderName } = req.body;
    if (!token || !email || !senderName) {
      return res.status(400).json({ success: false, message: "Missing required fields." });
    }

    const crypto    = require('crypto');
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');

    const db = getDb();

    const snap = await db.collection('users')
      .where('email', '==', email)
      .where('reactivationToken', '==', tokenHash)
      .limit(1)
      .get();

    if (snap.empty) {
      return res.status(404).json({ success: false, message: "Invalid link." });
    }

    const userDoc = snap.docs[0];
    const user    = userDoc.data();
    const uid     = userDoc.id;

    // Check expiry
    const expiry = user.reactivationTokenExpiry?.toDate?.()
      || new Date(user.reactivationTokenExpiry);
    if (new Date() > expiry) {
      return res.status(400).json({ success: false, message: "This link has expired." });
    }

    // Check for duplicate submission
    const existing = await db.collection('reactivations')
      .where('userId', '==', uid)
      .where('status', '==', 'pending')
      .limit(1)
      .get();

    if (!existing.empty) {
      return res.status(400).json({
        success: false,
        message: "Request already submitted. Please wait for admin review.",
      });
    }

    // Save reactivation request for admin to review
    await db.collection('reactivations').add({
      userId:     uid,
      email,
      firstName:  user.firstName || '',
      lastName:   user.lastName  || '',
      username:   user.username  || '',
      senderName,
      status:     'pending',
      createdAt:  new Date(),
    });
// After saving to 'reactivations' collection, add this:

// Notify admin by email
const resend = new Resend(process.env.RESEND_API_KEY);
await resend.emails.send({
  from:    'PromoEarn <noreply@promoearnapp.com>',
  to:      'contact.promoearn@gmail.com',
  subject: '🔔 New Reactivation Request — PromoEarn Admin',
  html: `
    <div style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:20px">
      <div style="background:#1E40AF;padding:20px;border-radius:12px 12px 0 0;text-align:center">
        <h2 style="color:#fff;margin:0">PromoEarn Admin</h2>
      </div>
      <div style="background:#fff;padding:28px;border:1px solid #E2E8F0;border-top:none;border-radius:0 0 12px 12px">
        <p style="font-size:15px;color:#0F172A">A user has submitted a reactivation request.</p>
        <div style="background:#EFF6FF;border-radius:10px;padding:16px;margin:16px 0;font-size:14px;color:#0F172A;line-height:1.9;">
          <p style="margin:0 0 4px;font-weight:700;">Request Details:</p>
          <p style="margin:0;"><strong>Name:</strong> ${user.firstName || ''} ${user.lastName || ''}</p>
          <p style="margin:0;"><strong>Email:</strong> ${email}</p>
          <p style="margin:0;"><strong>Username:</strong> @${user.username || 'N/A'}</p>
          <p style="margin:0;"><strong>Sender Name (transfer):</strong> ${senderName}</p>
          <p style="margin:0;"><strong>Submitted:</strong> ${new Date().toLocaleString('en-NG', { timeZone: 'Africa/Lagos' })} (WAT)</p>
        </div>
        <div style="text-align:center;margin:24px 0;">
          <a href="https://promoearnapp.com/reactivations.html"
             style="display:inline-block;background:#1E40AF;color:#fff;padding:14px 32px;border-radius:10px;text-decoration:none;font-weight:700;font-size:15px;">
            👉 Review in Admin Panel
          </a>
        </div>
        <p style="font-size:12px;color:#94A3B8;text-align:center;">
          © ${new Date().getFullYear()} PromoEarn Admin System
        </p>
      </div>
    </div>
  `,
}).catch(err => console.error('Admin notification email failed:', err));
// .catch so email failure doesn't break the user's response
    return res.json({
      success: true,
      message: "Request submitted. We'll review and restore your account within 24 hours.",
    });

  } catch (err) {
    console.error("requestReactivation error:", err);
    return res.status(500).json({ success: false, message: "Server error." });
  }
};
// ─── MANUAL ACTIVATION ────────────────────────────────────────────────────────
exports.manualActivation = async (req, res) => {
  try {
    const db  = getDb();
    const uid = req.user.uid;
    const { senderName, amountNGN } = req.body;

    if (!senderName || !senderName.trim()) {
      return res.status(400).json({ success: false, message: "Sender name is required." });
    }

    const userDoc = await db.collection("users").doc(uid).get();
    if (!userDoc.exists) {
      return res.status(404).json({ success: false, message: "User not found." });
    }
    const user = userDoc.data();

    if (user.isActivated) {
      return res.status(400).json({ success: false, message: "Account is already activated." });
    }

    const existing = await db.collection("pendingActivations")
      .where("userId", "==", uid)
      .where("status", "==", "pending")
      .limit(1)
      .get();

    if (!existing.empty) {
      return res.status(400).json({
        success: false,
        message: "You already have a pending activation under review. Please wait for admin approval.",
      });
    }

    await db.collection("pendingActivations").add({
      userId:     uid,
      username:   user.username || "",
      email:      user.email    || "",
      senderName: senderName.trim(),
      amountNGN:  amountNGN || 4500,
      status:     "pending",
      createdAt:  new Date(),
    });

    await db.collection("notifications").add({
      userId:    uid,
      title:     "⏳ Transfer Submitted!",
      body:      "We received your transfer details and will confirm your payment within 24 hours.",
      type:      "paymentAlerts",
      read:      false,
      createdAt: new Date(),
    });

    // Notify admin by email
    resend.emails.send({
      from:    'PromoEarn <noreply@promoearnapp.com>',
      to:      'contact.promoearn@gmail.com',
      subject: '🔔 New Activation Request — PromoEarn Admin',
      html: `
        <div style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:20px">
          <div style="background:#1E40AF;padding:20px;border-radius:12px 12px 0 0;text-align:center">
            <h2 style="color:#fff;margin:0">PromoEarn Admin</h2>
          </div>
          <div style="background:#fff;padding:28px;border:1px solid #E2E8F0;border-top:none;border-radius:0 0 12px 12px">
            <p style="font-size:15px;color:#0F172A">A user has submitted a <strong>manual bank transfer activation</strong>.</p>
            <div style="background:#EFF6FF;border-radius:10px;padding:16px;margin:16px 0;font-size:14px;color:#0F172A;line-height:1.9;">
              <p style="margin:0 0 4px;font-weight:700;">Details:</p>
              <p style="margin:0;"><strong>Username:</strong> @${user.username || 'N/A'}</p>
              <p style="margin:0;"><strong>Email:</strong> ${user.email || 'N/A'}</p>
              <p style="margin:0;"><strong>Sender Name:</strong> ${senderName.trim()}</p>
              <p style="margin:0;"><strong>Amount:</strong> ₦${(amountNGN || 4500).toLocaleString()}</p>
              <p style="margin:0;"><strong>Submitted:</strong> ${new Date().toLocaleString('en-NG', { timeZone: 'Africa/Lagos' })} (WAT)</p>
            </div>
            <div style="text-align:center;margin:24px 0;">
              <a href="https://promo-earn-admin.vercel.app"
                 style="display:inline-block;background:#1E40AF;color:#fff;padding:14px 32px;border-radius:10px;text-decoration:none;font-weight:700;font-size:15px;">
                👉 Review in Admin Panel
              </a>
            </div>
          </div>
        </div>
      `,
    }).catch(err => console.error('Admin activation email failed:', err));

    return res.status(201).json({
      success: true,
      message: "Transfer details submitted! Your account will be activated within 24 hours after we confirm your payment.",
    });

  } catch (err) {
    console.error("Manual activation error:", err);
    return res.status(500).json({ success: false, message: "Server error. Please try again." });
  }
};