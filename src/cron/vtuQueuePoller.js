// ── Automatic retry poller for queued VTU orders ───────────────────────────
// Runs on a schedule and calls the same retryPendingVtuOrders() logic the
// manual admin "process queue" button uses. If there's nothing pending,
// it's a cheap no-op (one Firestore query, no external API calls).
//
// Requires: npm install node-cron
//
// Wire this into your server entrypoint (e.g. server.js / app.js):
//   const { startVtuQueuePoller } = require("./cron/vtuQueuePoller");
//   startVtuQueuePoller();

const cron = require("node-cron");
const { retryPendingVtuOrders } = require("../controllers/vtuController");

// Every 5 minutes. Adjust the schedule to taste — more frequent means
// faster delivery after a topup, less frequent means fewer API calls.
const SCHEDULE = "*/5 * * * *";

let running = false;

exports.startVtuQueuePoller = () => {
  cron.schedule(SCHEDULE, async () => {
    if (running) return; // avoid overlapping runs if one takes a while
    running = true;
    try {
      const summary = await retryPendingVtuOrders();
      if (summary.attempted > 0) {
        console.log("[vtuQueuePoller]", summary);
      }
    } catch (err) {
      console.error("[vtuQueuePoller] error:", err);
    } finally {
      running = false;
    }
  });

  console.log(`[vtuQueuePoller] started — schedule: ${SCHEDULE}`);
};