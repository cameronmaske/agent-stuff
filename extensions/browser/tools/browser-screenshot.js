#!/usr/bin/env node

import { tmpdir } from "node:os";
import { join } from "node:path";
import { connectOrExit, getActivePageOrExit } from "./browser-utils.js";

const { browser } = await connectOrExit();
const page = await getActivePageOrExit(browser);

const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
const filename = `screenshot-${timestamp}.png`;
const filepath = join(tmpdir(), filename);

await page.screenshot({ path: filepath });

console.log(filepath);

await browser.disconnect();
