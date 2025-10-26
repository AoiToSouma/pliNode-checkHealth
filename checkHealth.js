const https = require("https");
const fs = require("fs");
const path = require("path");

// === 設定ファイル ===
const configPath = path.join(__dirname, "config.json");

function loadConfig() {
  try {
    const raw = fs.readFileSync(configPath, "utf8");
    const cfg = JSON.parse(raw);

    if (!Array.isArray(cfg.HEALTH_URLS) || !cfg.SLACK_WEBHOOK_URL) {
      throw new Error("Invalid config structure");
    }

    return {
      HEALTH_URLS: cfg.HEALTH_URLS,
      SLACK_WEBHOOK_URL: cfg.SLACK_WEBHOOK_URL,
      INTERVAL_SECONDS: cfg.INTERVAL_SECONDS || 60,
    };
  } catch (err) {
    console.error(`❌ Config load error: ${err.message}`);
    process.exit(1);
  }
}

let { HEALTH_URLS, SLACK_WEBHOOK_URL, INTERVAL_SECONDS } = loadConfig();

// 動的リロード対応
fs.watchFile(configPath, { interval: 5000 }, () => {
  console.log("🔄 Detected config.json change, reloading...");
  const cfg = loadConfig();
  HEALTH_URLS = cfg.HEALTH_URLS;
  SLACK_WEBHOOK_URL = cfg.SLACK_WEBHOOK_URL;
  INTERVAL_SECONDS = cfg.INTERVAL_SECONDS;
  console.log(`✅ Config reloaded (interval: ${INTERVAL_SECONDS}s)`);
});

// === 共通設定 ===
const agent = new https.Agent({ rejectUnauthorized: false });
let previousFailures = new Set();

// === Slack通知（Block Kit形式） ===
function sendSlackBlock(title, message, color) {
  const payload = JSON.stringify({
    attachments: [
      {
        color,
        blocks: [
          {
            type: "header",
            text: { type: "plain_text", text: title, emoji: true },
          },
          {
            type: "section",
            text: { type: "mrkdwn", text: message },
          },
          {
            type: "context",
            elements: [
              {
                type: "mrkdwn",
                text: `🕒 ${new Date().toLocaleString("ja-JP", {
                  timeZone: "Asia/Tokyo",
                })}`,
              },
            ],
          },
        ],
      },
    ],
  });

  const url = new URL(SLACK_WEBHOOK_URL);
  const options = {
    hostname: url.hostname,
    path: url.pathname + url.search,
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(payload),
    },
  };

  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      res.on("data", () => {});
      res.on("end", resolve);
    });
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

// === ヘルスチェック関数 ===
function fetchHealth(url) {
  return new Promise((resolve, reject) => {
    https
      .get(url, { agent }, (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          try {
            const json = JSON.parse(data);
            resolve(json);
          } catch (err) {
            reject(new Error("Invalid JSON response"));
          }
        });
      })
      .on("error", (err) => reject(err));
  });
}

// === メイン処理 ===
async function checkHealth() {
  console.log(`[${new Date().toISOString()}] 🩺 Health check start`);

  const currentFailures = new Set();
  const failMessages = [];

  for (const target of HEALTH_URLS) {
    try {
      const result = await fetchHealth(target.url);

      if (!result.data || !Array.isArray(result.data)) {
        const msg = `${target.name}: Unexpected JSON format`;
        console.error(`⚠️ ${msg}`);
        currentFailures.add(msg);
        failMessages.push(`• ${msg}`);
        continue;
      }

      const failing = result.data.filter(
        (item) => item.attributes?.status !== "passing"
      );

      if (failing.length > 0) {
        const details = failing
          .map(
            (c) =>
              `• *${target.name}* → ${c.attributes?.name || c.id}: \`${c.attributes?.status}\``
          )
          .join("\n");
        console.error(`❌ ${details}`);
        for (const f of failing)
          currentFailures.add(`${target.name}:${f.attributes?.name || f.id}`);
        failMessages.push(details);
      } else {
        console.log(`✅ ${target.name}: All checks passing.`);
      }
    } catch (err) {
      const msg = `• *${target.name}*: Error fetching health (${err.message})`;
      console.error(`❌ ${msg}`);
      currentFailures.add(`${target.name}:ConnectionError`);
      failMessages.push(msg);
    }
  }

  const newFailures = [...currentFailures].filter(
    (f) => !previousFailures.has(f)
  );
  const recovered = [...previousFailures].filter(
    (f) => !currentFailures.has(f)
  );

  // Slack通知処理
  if (newFailures.length > 0) {
    const message = `${failMessages.join("\n")}`;
    try {
      await sendSlackBlock("🚨 障害検出", message, "#ff4d4d");
      console.log("📨 Sent Slack alert for new failures.");
    } catch (err) {
      console.error("❌ Slack send error:", err.message);
    }
  } else if (currentFailures.size === 0 && previousFailures.size > 0) {
    const message = `以前発生していたすべての障害が解消されました。\nシステムは正常に稼働しています。`;
    try {
      await sendSlackBlock("✅ 全システム回復", message, "#36a64f");
      console.log("📨 Sent Slack recovery message.");
    } catch (err) {
      console.error("❌ Slack send error:", err.message);
    }
  }

  previousFailures = currentFailures;
  console.log(`[${new Date().toISOString()}] ✅ Health check done\n`);
}

// === 起動通知 ===
async function notifyStart() {
  const message = `監視を開始しました。\n対象URL数: *${HEALTH_URLS.length}*\n間隔: *${INTERVAL_SECONDS}秒*`;
  try {
    await sendSlackBlock("🚀 監視開始", message, "#439FE0");
    console.log("📨 Sent startup message to Slack.");
  } catch (err) {
    console.error("❌ Failed to send startup message:", err.message);
  }
}

// === 定期実行 ===
function startMonitoring() {
  console.log(`🚀 Starting health monitor (interval ${INTERVAL_SECONDS}s)`);
  notifyStart();
  checkHealth();
  setInterval(checkHealth, INTERVAL_SECONDS * 1000);
}

// === シグナルハンドラ ===
process.on("SIGINT", () => {
  console.log("🛑 Caught SIGINT, exiting...");
  process.exit(0);
});
process.on("SIGTERM", () => {
  console.log("🛑 Caught SIGTERM, exiting...");
  process.exit(0);
});

// === スタート ===
startMonitoring();
