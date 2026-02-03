#!/usr/bin/env node

import fs from "node:fs";
import { execFileSync } from "node:child_process";
import puppeteer from "puppeteer-core";

const DEFAULT_PORT = Number.parseInt(process.env.BROWSER_TOOLS_PORT || "9222", 10);
const DEFAULT_TIMEOUT_MS = Number.parseInt(process.env.BROWSER_TOOLS_TIMEOUT || "5000", 10);

const POWERSHELL_PATH =
  process.env.BROWSER_TOOLS_POWERSHELL ||
  "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe";

function normalizeUrl(url) {
  if (!url) return null;
  if (url.startsWith("http://") || url.startsWith("https://")) return url;
  return `http://${url}`;
}

function buildUrl(host, port = DEFAULT_PORT) {
  if (!host) return null;
  return normalizeUrl(`${host}:${port}`);
}

function getEnvUrl() {
  return (
    process.env.BROWSER_TOOLS_URL ||
    process.env.CHROME_CDP_URL ||
    process.env.CDP_URL ||
    null
  );
}

function getEnvHost() {
  return process.env.BROWSER_TOOLS_HOST || process.env.CHROME_CDP_HOST || null;
}

function getWSLHostFromPowerShell() {
  if (!fs.existsSync(POWERSHELL_PATH)) return null;
  const command =
    "Get-NetIPAddress -AddressFamily IPv4 | " +
    "Where-Object {$_.InterfaceAlias -like 'vEthernet (WSL*'} | " +
    "Select-Object -First 1 -ExpandProperty IPAddress";

  try {
    const output = execFileSync(
      POWERSHELL_PATH,
      ["-NoProfile", "-Command", command],
      { encoding: "utf8" }
    )
      .trim()
      .split(/\r?\n/)[0];
    return output || null;
  } catch {
    return null;
  }
}

function getWSLHostFromResolv() {
  try {
    const data = fs.readFileSync("/etc/resolv.conf", "utf8");
    const match = data.match(/nameserver\s+(\S+)/);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

function unique(items) {
  const seen = new Set();
  return items.filter((item) => {
    if (!item || seen.has(item)) return false;
    seen.add(item);
    return true;
  });
}

export function getCandidateUrls() {
  const candidates = [];
  const envUrl = normalizeUrl(getEnvUrl());
  if (envUrl) candidates.push(envUrl);

  const envHost = getEnvHost();
  if (envHost) candidates.push(buildUrl(envHost));

  const wslHost = getWSLHostFromPowerShell() || getWSLHostFromResolv();
  if (wslHost) candidates.push(buildUrl(wslHost));

  candidates.push("http://localhost:9222");
  candidates.push("http://127.0.0.1:9222");

  return unique(candidates);
}

function timeout(ms) {
  return new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), ms));
}

export async function connectToBrowser({ timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const candidates = getCandidateUrls();
  let lastError;

  for (const browserURL of candidates) {
    try {
      const browser = await Promise.race([
        puppeteer.connect({ browserURL, defaultViewport: null }),
        timeout(timeoutMs),
      ]);
      return { browser, browserURL };
    } catch (error) {
      lastError = error;
    }
  }

  const tried = candidates.length > 0 ? candidates.join(", ") : "(no candidates)";
  const error = new Error(`Could not connect to Chrome DevTools. Tried: ${tried}`);
  error.cause = lastError;
  throw error;
}

export async function connectOrExit() {
  try {
    return await connectToBrowser();
  } catch (error) {
    console.error("✗ Could not connect to Chrome DevTools.");
    console.error("  Run: node browser-start.js");
    console.error("  Or set BROWSER_TOOLS_URL=http://<windows-host>:9222");
    if (error?.message) console.error(`  Details: ${error.message}`);
    process.exit(1);
  }
}

export async function waitForBrowser({ retries = 20, delayMs = 500, timeoutMs = 2000 } = {}) {
  let lastError;
  for (let i = 0; i < retries; i++) {
    try {
      const { browser, browserURL } = await connectToBrowser({ timeoutMs });
      await browser.disconnect();
      return { browserURL };
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw lastError || new Error("Timeout waiting for Chrome");
}

export async function getActivePage(browser) {
  const pages = await browser.pages();
  return pages.at(-1) || null;
}

export async function getActivePageOrNew(browser) {
  const page = await getActivePage(browser);
  if (page) return page;
  return browser.newPage();
}

export async function getActivePageOrExit(browser) {
  const page = await getActivePage(browser);
  if (!page) {
    console.error("✗ No active tab found");
    await browser.disconnect();
    process.exit(1);
  }
  return page;
}
