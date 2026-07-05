const axios = require("axios");

const flw = axios.create({
  baseURL: "https://api.flutterwave.com/v3",
  headers: {
    Authorization: `Bearer ${process.env.FLW_SECRET_KEY}`,
    "Content-Type": "application/json",
  },
});

module.exports = { flw };