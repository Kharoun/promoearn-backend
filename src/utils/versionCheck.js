const compareVersions = (a, b) => {
    const pa = String(a || "0").split(".").map(Number);
    const pb = String(b || "0").split(".").map(Number);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      const na = pa[i] || 0, nb = pb[i] || 0;
      if (na > nb) return 1;
      if (na < nb) return -1;
    }
    return 0;
  };
  
// versionCheck.js
const checkVersionGate = async (req, getDb) => {
    console.log("PLATFORM HEADER RECEIVED:", req.headers["x-platform"]);
    if (req.headers["x-platform"] === "web") return null;
    const clientVersion = req.headers["x-app-version"];
    const db = getDb();
    const versionDoc = await db.collection("config").doc("appVersion").get();
    if (!versionDoc.exists) return null;
  
    const { minVersion, updateUrl } = versionDoc.data();
    if (!minVersion) return null;
  
    if (!clientVersion || compareVersions(clientVersion, minVersion) < 0) {
      return {
        status: 426,
        body: {
          success: false,
          message: "PromoEarn has been updated! Please update from the Play Store to keep using your account.",
          code: "UPDATE_REQUIRED",
          data: { updateUrl: updateUrl || "https://play.google.com/store/apps/details?id=com.promoearn.app" },
        },
      };
    }
    return null;
  };
  
  module.exports = { compareVersions, checkVersionGate };