#!/usr/bin/env node

import { connectOrExit, getActivePageOrNew } from "./browser-utils.js";

const url = process.argv[2];
const newTab = process.argv.includes("--new");

if (!url || url.startsWith("--")) {
  console.log("Usage: browser-nav.js <url> [--new]");
  console.log("\nExamples:");
  console.log("  browser-nav.js https://example.com       # Navigate current tab");
  console.log("  browser-nav.js https://example.com --new # Open in new tab");
  process.exit(1);
}

const { browser } = await connectOrExit();

let page;
if (newTab) {
  page = await browser.newPage();
} else {
  page = await getActivePageOrNew(browser);
}

await page.goto(url, { waitUntil: "domcontentloaded" });
console.log(newTab ? "✓ Opened:" : "✓ Navigated to:", url);

await browser.disconnect();
