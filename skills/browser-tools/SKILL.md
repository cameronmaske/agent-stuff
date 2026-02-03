---
name: browser-tools
description: Interactive browser automation via Chrome DevTools Protocol from WSL to a Windows Chrome instance. Use when you need to interact with web pages, test frontends, or when user interaction with a visible browser is required.
---

# Browser Tools (WSL → Windows Chrome)

Chrome DevTools Protocol tools for agent-assisted web automation. These tools connect to Chrome running on Windows with remote debugging enabled on port 9222.

## Setup

Run once before first use:

```bash
cd {baseDir}/browser-tools
npm install
```

## Start Chrome (Windows)

```bash
node {baseDir}/browser-tools/browser-start.js [--no-watch]
```

This runs the Windows script at `C:\Scripts\launch-chrome-pi.ps1`. If your script is elsewhere, set:

```bash
export BROWSER_TOOLS_START_SCRIPT="C:\\Path\\To\\launch-chrome-pi.ps1"
```

If it fails due to admin permissions, run the script directly in Windows PowerShell.

By default this also starts the background watcher (`watch.js`) that logs console errors and network traffic. Use `--no-watch` to skip.

## Configure Connection (if auto-detect fails)

Set the CDP URL explicitly:

```bash
export BROWSER_TOOLS_URL="http://172.18.0.1:9222"
```

## Navigate

```bash
node {baseDir}/browser-tools/browser-nav.js https://example.com
node {baseDir}/browser-tools/browser-nav.js https://example.com --new
```

Navigate to URLs. Use `--new` to open in a new tab instead of reusing the current tab.

## Evaluate JavaScript

```bash
node {baseDir}/browser-tools/browser-eval.js 'document.title'
node {baseDir}/browser-tools/browser-eval.js 'document.querySelectorAll("a").length'
```

Execute JavaScript in the active tab. Code runs in an async context. Use this to extract data, inspect page state, or perform DOM operations programmatically.

## Screenshot

```bash
node {baseDir}/browser-tools/browser-screenshot.js
```

Capture the current viewport and return a temporary file path.

## Pick Elements

```bash
node {baseDir}/browser-tools/browser-pick.js "Click the submit button"
```

**IMPORTANT**: Use this tool when you need the user to select specific DOM elements. It launches an interactive picker in the browser. The user can select multiple elements (Cmd/Ctrl+Click) and press Enter when done. The tool returns details for the selected elements.

## Cookies

```bash
node {baseDir}/browser-tools/browser-cookies.js
```

Display all cookies for the current tab including domain, path, httpOnly, and secure flags.

## Dismiss Cookie Dialogs

```bash
node {baseDir}/browser-tools/dismiss-cookies.js
node {baseDir}/browser-tools/dismiss-cookies.js --reject
```

Automatically accept or reject cookie consent dialogs.

## Background Logging (Console + Errors + Network)

Logs are written to:

```
~/.cache/agent-web/logs/YYYY-MM-DD/<targetId>.jsonl
```

The watcher starts automatically with `browser-start.js`, or run it manually:

```bash
node {baseDir}/browser-tools/watch.js
```

Tail latest log:

```bash
node {baseDir}/browser-tools/logs-tail.js
node {baseDir}/browser-tools/logs-tail.js --follow
node {baseDir}/browser-tools/logs-tail.js --file /path/to/log.jsonl
```

Summarize network responses:

```bash
node {baseDir}/browser-tools/net-summary.js
node {baseDir}/browser-tools/net-summary.js --file /path/to/log.jsonl
```

## Extract Page Content

```bash
node {baseDir}/browser-tools/browser-content.js https://example.com
```

Navigate to a URL and extract readable content as markdown. Uses Mozilla Readability for article extraction and Turndown for HTML-to-markdown conversion.

## When to Use

- Testing frontend code in a real browser
- Interacting with pages that require JavaScript
- When user needs to visually see or interact with a page
- Debugging authentication or session issues
- Scraping dynamic content that requires JS execution
