const { createNotification } = require("./notificationsController");
const { getDb } = require("../config/firebase");
const { v4: uuidv4 } = require("uuid");
const https = require("https");

// ─── Constants ────────────────────────────────────────────────────────────────
const NGN_RATE         = 1500;
const REGISTRATION_FEE = 4500 / NGN_RATE;  // = $3.00
const WELCOME_BONUS    = 0;
const TASK_REWARD      = 0.17;
const REFERRAL_BONUS   = 1.33;
const MIN_WITHDRAWAL = 5010 / NGN_RATE;  // = $3.34
const WITHDRAWAL_FEE = 100 / NGN_RATE;  // ₦100 = ~$0.067
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
    const response = await paystackRequest("GET", "/bank?currency=NGN&perPage=100");
    if (!response.status) {
      return res.status(400).json({ success: false, message: "Failed to fetch banks." });
    }
    return res.status(200).json({
      success: true,
      data: { banks: response.data },
    });
  } catch (err) {
    console.error("Get banks error:", err);
    return res.status(500).json({ success: false, message: "Failed to fetch banks." });
  }
};

// ─── VERIFY ACCOUNT NUMBER ────────────────────────────────────────────────────
exports.verifyAccount = async (req, res) => {
  try {
    const { accountNumber, bankCode } = req.body;
    if (!accountNumber || !bankCode) {
      return res.status(400).json({ success: false, message: "Account number and bank code are required." });
    }
    const response = await paystackRequest(
      "GET",
      `/bank/resolve?account_number=${accountNumber}&bank_code=${bankCode}`
    );
    if (!response.status) {
      return res.status(400).json({ success: false, message: "Could not verify account. Please check the details." });
    }
    return res.status(200).json({
      success: true,
      data: {
        accountName:   response.data.account_name,
        accountNumber: response.data.account_number,
      },
    });
  } catch (err) {
    console.error("Verify account error:", err);
    return res.status(500).json({ success: false, message: "Account verification failed." });
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
        subaccounts: [
          {
            subaccount: "ACCT_w3z0tqg2smqk1h9", // PROMO EARN DIGITAL HUB - Sterling Bank
            share: 55,
          },
          {
            subaccount: "ACCT_kauokc340c1dbv7", // EMMANUEL - OPay
            share: 44,
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