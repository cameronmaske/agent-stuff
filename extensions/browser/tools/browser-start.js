#!/usr/bin/env node

import fs from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { waitForBrowser } from "./browser-utils.js";

const defaultScript = "C:\\Scripts\\launch-chrome-pi.ps1";
const defaultPowerShell =
  "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe";

let scriptPath = process.env.BROWSER_TOOLS_START_SCRIPT || defaultScript;
let powerShellPath = process.env.BROWSER_TOOLS_POWERSHELL || defaultPowerShell;
let skipWait = false;
let skipWatch = false;

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
    skipWatch = true;
  } else {
    console.log("Usage: browser-start.js [--script <path>] [--powershell <path>] [--no-wait] [--no-watch]");
    process.exit(1);
  }
}

if (!fs.existsSync(powerShellPath)) {
  powerShellPath = "powershell.exe";
}

const result = spawnSync(
  powerShellPath,
  ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptPath],
  { stdio: "inherit" }
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
  const { browserURL } = await waitForBrowser();
  console.log(`✓ Chrome reachable at ${browserURL}`);

  if (!skipWatch) {
    const scriptDir = dirname(fileURLToPath(import.meta.url));
    const watcherPath = join(scriptDir, "watch.js");
    spawn(process.execPath, [watcherPath], { detached: true, stdio: "ignore" }).unref();
  }
} catch (error) {
  console.error("✗ Chrome did not become reachable.");
  if (error?.message) console.error(`  Details: ${error.message}`);
  process.exit(1);
}
