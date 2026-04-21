const jwt = require("jsonwebtoken");

/**
 * Issue a short-lived access token.
 */
const signAccessToken = (payload) =>
  jwt.sign(payload, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || "7d",
  });

/**
 * Issue a long-lived refresh token.
 */
const signRefreshToken = (payload) =>
  jwt.sign(payload, process.env.JWT_REFRESH_SECRET, {
    expiresIn: process.env.JWT_REFRESH_EXPIRES_IN || "30d",
  });

/**
 * Verify an access token. Returns decoded payload or throws.
 */
const verifyAccessToken = (token) =>
  jwt.verify(token, process.env.JWT_SECRET);

/**
 * Verify a refresh token. Returns decoded payload or throws.
 */
const verifyRefreshToken = (token) =>
  jwt.verify(token, process.env.JWT_REFRESH_SECRET);

/**
 * Build the standard auth response object returned to the client.
 */
const buildAuthTokens = (user) => {
  const payload = {
    uid: user.uid,
    email: user.email,
    phone: user.phone,
    username: user.username,
  };

  return {
    accessToken: signAccessToken(payload),
    refreshToken: signRefreshToken({ uid: user.uid }),
    expiresIn: process.env.JWT_EXPIRES_IN || "7d",
  };
};

module.exports = { signAccessToken, signRefreshToken, verifyAccessToken, verifyRefreshToken, buildAuthTokens };
