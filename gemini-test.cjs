
require("dotenv").config({
  path: require("node:path").resolve("apps/worker/.env"),
  override: true
});

const https = require("node:https");

const key = process.env.GEMINI_API_KEY;
const model = process.env.GEMINI_MODEL || "gemini-2.5-flash";

console.log("Gemini key loaded:", Boolean(key));
console.log("Gemini model:", model);

if (!key) {
  console.error("ERROR: GEMINI_API_KEY is missing from apps/worker/.env");
  process.exit(1);
}

const body = JSON.stringify({
  contents: [
    { parts: [{ text: "Reply with GEMINI_OK" }] }
  ]
});

const req = https.request({
  hostname: "generativelanguage.googleapis.com",
  path: `/v1beta/models/${model}:generateContent`,
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "x-goog-api-key": key,
    "Content-Length": Buffer.byteLength(body)
  },
  timeout: 20000
}, (res) => {
  let response = "";

  res.setEncoding("utf8");
  res.on("data", chunk => response += chunk);

  res.on("end", () => {
    console.log("HTTP status:", res.statusCode);

    try {
      const result = JSON.parse(response);

      if (res.statusCode === 200) {
        console.log(
          "Gemini response:",
          result.candidates?.[0]?.content?.parts?.[0]?.text
        );
      } else {
        console.log("API error:", result.error?.message || response);
      }
    } catch {
      console.log("Response:", response.slice(0, 300));
    }
  });
});

req.on("timeout", () => {
  req.destroy(new Error("Request timed out after 20 seconds"));
});

req.on("error", (error) => {
  console.error("HTTPS ERROR:", error.message);
});

req.end(body);
