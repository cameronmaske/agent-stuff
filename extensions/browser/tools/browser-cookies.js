#!/usr/bin/env node

import { connectOrExit, getActivePageOrExit } from "./browser-utils.js";

const { browser } = await connectOrExit();
const page = await getActivePageOrExit(browser);

const cookies = await page.cookies();

for (const cookie of cookies) {
  console.log(`${cookie.name}: ${cookie.value}`);
  console.log(`  domain: ${cookie.domain}`);
  console.log(`  path: ${cookie.path}`);
  console.log(`  httpOnly: ${cookie.httpOnly}`);
  console.log(`  secure: ${cookie.secure}`);
  console.log("");
}

await browser.disconnect();
