#!/usr/bin/env node

const fs = require("node:fs");
const { spawnSync } = require("node:child_process");

const defaultScript = "C:\\Scripts\\launch-chrome-pi.ps1";
const defaultPowerShell =
  "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe";

const DEFAULT_PORT = Number.parseInt(process.env.BROWSER_TOOLS_PORT || "9222", 10);

let scriptPath = process.env.BROWSER_TOOLS_START_SCRIPT || defaultScript;
let powerShellPath = process.env.BROWSER_TOOLS_POWERSHELL || defaultPowerShell;
let skipWait = false;

const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === "--script" && args[i + 1]) {
    scriptPath = args[i + 1];
    i++;
  } else if (arg === "--powershell" && args[i + 1]) {
    powerShellPath = args[i + 1];
    i++;
  } else if (arg === "--no-wait") {
    skipWait = true;
  } else if (arg === "--no-watch") {
    // Accepted for compatibility. This lightweight helper does not start a watcher.
  } else {
    console.log(
      "Usage: browser-start.js [--script <path>] [--powershell <path>] [--no-wait] [--no-watch]",
    );
    process.exit(1);
  }
}

function normalizeUrl(url) {
  if (!url) return null;
  if (url.startsWith("http://") || url.startsWith("https://")) {
    return url.replace(/\/$/, "");
  }
  return `http://${url}`.replace(/\/$/, "");
}

function buildUrl(host, port = DEFAULT_PORT) {
  if (!host) return null;
  return normalizeUrl(`${host}:${port}`);
}

function unique(items) {
  const seen = new Set();
  const out = [];
  for (const item of items) {
    if (!item || seen.has(item)) continue;
    seen.add(item);
    out.push(item);
  }
  return out;
}

function getWSLHostFromResolv() {
  try {
    const content = fs.readFileSync("/etc/resolv.conf", "utf8");
    const match = content.match(/nameserver\s+(\S+)/);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

function getCandidateCdpUrls() {
  const envUrl =
    process.env.BROWSER_TOOLS_URL ||
    process.env.CHROME_CDP_URL ||
    process.env.CDP_URL ||
    null;

  const envHost =
    process.env.BROWSER_TOOLS_HOST || process.env.CHROME_CDP_HOST || null;

  const wslHost = getWSLHostFromResolv();

  return unique([
    normalizeUrl(envUrl),
    buildUrl(envHost),
    buildUrl(wslHost),
    "http://localhost:9222",
    "http://127.0.0.1:9222",
  ]);
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchJson(url, timeoutMs = 1500) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timeoutId);
  }
}

async function waitForBrowser(retries = 30, delayMs = 500) {
  const candidates = getCandidateCdpUrls();
  for (let attempt = 0; attempt < retries; attempt++) {
    for (const baseUrl of candidates) {
      try {
        const info = await fetchJson(`${baseUrl}/json/version`);
        if (info && info.webSocketDebuggerUrl) {
          return baseUrl;
        }
      } catch {
        // Try next endpoint
      }
    }
    await sleep(delayMs);
  }
  throw new Error("Chrome launched but CDP endpoint is still unreachable.");
}

(async () => {
  if (!fs.existsSync(powerShellPath)) {
    powerShellPath = "powershell.exe";
  }

  const result = spawnSync(
    powerShellPath,
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptPath],
    { stdio: "inherit" },
  );

  if (result.error) {
    console.error(`✗ Failed to start PowerShell: ${result.error.message}`);
    console.error("  Run the script directly in Windows PowerShell:");
    console.error(`  ${scriptPath}`);
    process.exit(1);
  }

  if (result.status !== 0) {
    console.error("✗ PowerShell script failed.");
    console.error("  Run the script directly in Windows PowerShell:");
    console.error(`  ${scriptPath}`);
    process.exit(result.status ?? 1);
  }

  if (skipWait) {
    process.exit(0);
  }

  try {
    const browserURL = await waitForBrowser();
    console.log(`✓ Chrome reachable at ${browserURL}`);
  } catch (error) {
    console.error("✗ Chrome did not become reachable.");
    if (error && error.message) {
      console.error(`  Details: ${error.message}`);
    }
    process.exit(1);
  }
})();
