const checkVersionGate = async (req, getDb) => {
  console.log("PLATFORM HEADER:", req.headers["x-platform"]);
  if (req.headers["x-platform"] === "web") return null;

  const clientVersion = req.headers["x-app-version"];
  console.log("CLIENT VERSION HEADER:", clientVersion);

  const db = getDb();
  const versionDoc = await db.collection("config").doc("appVersion").get();
  console.log("VERSION DOC EXISTS:", versionDoc.exists, "DATA:", versionDoc.data());

  if (!versionDoc.exists) return null;

  const { minVersion, updateUrl } = versionDoc.data();
  if (!minVersion) {
    console.log("NO minVersion FIELD FOUND — gate skipped");
    return null;
  }

  const cmp = compareVersions(clientVersion, minVersion);
  console.log(`COMPARING client="${clientVersion}" vs min="${minVersion}" → result=${cmp}`);

  if (!clientVersion || cmp < 0) {
    console.log("🚫 BLOCKING LOGIN — version too old");
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