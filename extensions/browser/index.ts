import {
  existsSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
  truncateHead,
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
} from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";

const TOOL_DESCRIPTION = `Browser automation via agent-browser CLI (WSL → Windows Chrome).
Workflow: open URL → snapshot -i (get refs like [ref=e1]) → interact → re-snapshot.

Behavior:
  - If Chrome is not reachable, this tool auto-starts it (via browser-start.js)
  - Each pi session gets a fresh dedicated tab
  - Tab/session/connect commands are managed automatically by the tool

Commands:
  open <url> - Navigate to URL
  snapshot -i - Interactive elements with refs (re-snapshot after navigation)
  click <ref> - Click element (e.g. @e1)
  fill <ref> <text> - Clear and type
  type <ref> <text> - Type without clearing
  select <ref> <value> - Select dropdown
  press <key> - Press key (Enter, Tab, etc.)
  scroll <dir> [px] - Scroll (up/down/left/right)
  get text|url|title [ref] - Get information
  wait <ref|ms> - Wait for element or time
  screenshot [--full] - Take screenshot (image returned inline)
  close - Close this session's dedicated tab`;

const DEFAULT_CDP_PORT = Number.parseInt(
  process.env.BROWSER_TOOLS_PORT || "9222",
  10,
);
const DEFAULT_BROWSER_START_HELPER = join(
  dirname(fileURLToPath(import.meta.url)),
  "browser-start.js",
);
const RESERVED_COMMANDS = new Set(["connect", "tab", "window", "session"]);

interface ManagedSession {
  piSessionKey: string;
  browserSession: string;
  cdpUrl: string;
  tabIndex: number;
}

interface AgentBrowserJsonResult {
  success: boolean;
  data?: unknown;
  error?: string | null;
  type?: string;
}

const managedSessions = new Map<string, ManagedSession>();

type BrowserPhase = "disconnected" | "launching" | "connecting" | "connected" | "error";

const browserUiState: {
  lastCtx: any;
  phase: BrowserPhase;
  browserSession: string | null;
  tabIndex: number | null;
  runningAction: string | null;
  error: string | null;
} = {
  lastCtx: null,
  phase: "disconnected",
  browserSession: null,
  tabIndex: null,
  runningAction: null,
  error: null,
};

function shortText(value: string | null | undefined, max = 56): string {
  if (!value) return "";
  if (value.length <= max) return value;
  return `${value.slice(0, max - 1)}…`;
}

function renderBrowserStatus(ctx?: any): void {
  const targetCtx = ctx || browserUiState.lastCtx;
  if (!targetCtx || !targetCtx.hasUI) return;

  // Keep footer clean: hide browser status when fully idle/disconnected.
  if (
    browserUiState.phase === "disconnected" &&
    !browserUiState.runningAction &&
    !browserUiState.error
  ) {
    targetCtx.ui.setStatus("browser", undefined);
    return;
  }

  let text: string;
  if (browserUiState.phase === "launching") {
    text = "browser: launching Chrome…";
  } else if (browserUiState.phase === "connecting") {
    text = "browser: connecting…";
  } else if (browserUiState.phase === "connected") {
    text = "browser: connected";
    if (typeof browserUiState.tabIndex === "number") {
      text += ` • tab ${browserUiState.tabIndex}`;
    }
  } else if (browserUiState.phase === "error") {
    text = `browser: error • ${shortText(browserUiState.error || "unknown error")}`;
  } else {
    text = "browser: disconnected";
  }

  if (browserUiState.runningAction) {
    text += ` • running ${browserUiState.runningAction}`;
  }

  targetCtx.ui.setStatus("browser", targetCtx.ui.theme.fg("dim", text));
}

function updateBrowserStatus(
  patch: Partial<{
    phase: BrowserPhase;
    browserSession: string | null;
    tabIndex: number | null;
    runningAction: string | null;
    error: string | null;
  }>,
  ctx?: any,
): void {
  Object.assign(browserUiState, patch);
  renderBrowserStatus(ctx);
}

function setBrowserUiContext(ctx: any): void {
  browserUiState.lastCtx = ctx;
  renderBrowserStatus(ctx);
}

function syncStatusFromManagedSessions(ctx?: any, preferredKey?: string): void {
  const preferred = preferredKey ? managedSessions.get(preferredKey) : undefined;
  const fallback = managedSessions.values().next().value as ManagedSession | undefined;
  const managed = preferred || fallback;

  if (!managed) {
    updateBrowserStatus(
      {
        phase: "disconnected",
        browserSession: null,
        tabIndex: null,
        runningAction: null,
        error: null,
      },
      ctx,
    );
    return;
  }

  updateBrowserStatus(
    {
      phase: "connected",
      browserSession: managed.browserSession,
      tabIndex: managed.tabIndex,
      error: null,
    },
    ctx,
  );
}

function writeTempFile(content: string, prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `pi-browser-${prefix}-`));
  const file = join(dir, "output.txt");
  writeFileSync(file, content);
  return file;
}

function normalizeUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  if (url.startsWith("http://") || url.startsWith("https://")) {
    return url.replace(/\/$/, "");
  }
  return `http://${url}`.replace(/\/$/, "");
}

function buildUrl(host: string | null | undefined, port = DEFAULT_CDP_PORT): string | null {
  if (!host) return null;
  return normalizeUrl(`${host}:${port}`);
}

function unique(items: (string | null)[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of items) {
    if (!item || seen.has(item)) continue;
    seen.add(item);
    out.push(item);
  }
  return out;
}

function getWSLHostFromResolv(): string | null {
  try {
    const content = readFileSync("/etc/resolv.conf", "utf8");
    const match = content.match(/nameserver\s+(\S+)/);
    return match?.[1] || null;
  } catch {
    return null;
  }
}

function getCandidateCdpUrls(): string[] {
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

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchJson(url: string, timeoutMs = 1500): Promise<unknown> {
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

async function findReachableCdpUrl(): Promise<string | null> {
  for (const baseUrl of getCandidateCdpUrls()) {
    try {
      const info = (await fetchJson(`${baseUrl}/json/version`)) as {
        webSocketDebuggerUrl?: string;
      };
      if (info?.webSocketDebuggerUrl) {
        return baseUrl;
      }
    } catch {
      // Try next candidate.
    }
  }
  return null;
}

async function launchChromeViaHelper(pi: ExtensionAPI): Promise<void> {
  if (process.env.BROWSER_TOOLS_AUTO_START === "0") {
    throw new Error(
      "Chrome not reachable and auto-start disabled (BROWSER_TOOLS_AUTO_START=0)",
    );
  }

  const helperPath =
    process.env.BROWSER_TOOLS_LAUNCH_HELPER || DEFAULT_BROWSER_START_HELPER;

  if (!existsSync(helperPath)) {
    throw new Error(
      `Chrome launch helper not found at ${helperPath}. Set BROWSER_TOOLS_LAUNCH_HELPER or start Chrome manually.`,
    );
  }

  const result = await pi.exec("node", [helperPath, "--no-watch"], {
    timeout: 90000,
  });

  if (result.code !== 0) {
    const details = (result.stderr || result.stdout || "").trim();
    throw new Error(details || "Failed to launch Chrome via helper script");
  }
}

async function ensureCdpAvailable(pi: ExtensionAPI, ctx: any): Promise<string> {
  const reachable = await findReachableCdpUrl();
  if (reachable) {
    updateBrowserStatus({ phase: "connecting", error: null }, ctx);
    return reachable;
  }

  updateBrowserStatus({ phase: "launching", error: null }, ctx);

  if (ctx.hasUI) {
    ctx.ui.notify("Chrome not reachable, launching...", "info");
  }

  await launchChromeViaHelper(pi);

  for (let attempt = 0; attempt < 30; attempt++) {
    const url = await findReachableCdpUrl();
    if (url) {
      updateBrowserStatus({ phase: "connecting", error: null }, ctx);
      if (ctx.hasUI) {
        ctx.ui.notify(`Chrome reachable at ${url}`, "info");
      }
      return url;
    }
    await sleep(500);
  }

  throw new Error(
    "Chrome launched but CDP endpoint is still unreachable. Check remote-debugging port/proxy setup.",
  );
}

function splitCommand(command: string): string[] {
  const args: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let escaped = false;

  for (const ch of command.trim()) {
    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }

    if (ch === "\\") {
      escaped = true;
      continue;
    }

    if (quote) {
      if (ch === quote) {
        quote = null;
      } else {
        current += ch;
      }
      continue;
    }

    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }

    if (/\s/.test(ch)) {
      if (current.length > 0) {
        args.push(current);
        current = "";
      }
      continue;
    }

    current += ch;
  }

  if (escaped) current += "\\";
  if (quote) throw new Error("Unterminated quoted string in browser command");
  if (current.length > 0) args.push(current);

  return args;
}

function getPiSessionKey(ctx: any): string {
  const sessionFile = ctx.sessionManager.getSessionFile();
  if (sessionFile) return sessionFile;
  return `ephemeral:${ctx.cwd}:${process.pid}`;
}

function shortHash(value: string): string {
  return createHash("sha1").update(value).digest("hex").slice(0, 10);
}

function generateBrowserSessionName(piSessionKey: string): string {
  const nonce = randomBytes(3).toString("hex");
  return `pi-${shortHash(piSessionKey)}-${nonce}`;
}

async function runAgentBrowserJson(
  pi: ExtensionAPI,
  sessionName: string,
  cdpUrl: string,
  args: string[],
  options?: { timeout?: number; signal?: AbortSignal },
): Promise<{ response: AgentBrowserJsonResult; raw: string }> {
  const fullArgs = [
    "--session",
    sessionName,
    "--cdp",
    cdpUrl,
    "--json",
    ...args,
  ];

  const result = await pi.exec("agent-browser", fullArgs, {
    timeout: options?.timeout ?? 60000,
    signal: options?.signal,
  });

  if (result.code !== 0) {
    const details = (result.stderr || result.stdout || "").trim();
    throw new Error(details || `agent-browser failed with exit code ${result.code}`);
  }

  const raw = result.stdout.trim();
  if (!raw) {
    return { response: { success: true, data: null }, raw };
  }

  let parsed: AgentBrowserJsonResult;
  try {
    parsed = JSON.parse(raw) as AgentBrowserJsonResult;
  } catch {
    throw new Error(`Failed to parse agent-browser JSON output: ${raw.slice(0, 500)}`);
  }

  if (!parsed.success) {
    throw new Error(parsed.error || "agent-browser command failed");
  }

  return { response: parsed, raw };
}

async function createFreshManagedTab(
  pi: ExtensionAPI,
  managed: ManagedSession,
  signal: AbortSignal | undefined,
): Promise<number> {
  const { response } = await runAgentBrowserJson(
    pi,
    managed.browserSession,
    managed.cdpUrl,
    ["tab", "new", "about:blank"],
    { signal },
  );

  const index = Number((response.data as { index?: number } | undefined)?.index);
  if (!Number.isFinite(index)) {
    throw new Error("Could not create a new tab for this session");
  }

  // Best-effort marker for debugging/inspection.
  await runAgentBrowserJson(
    pi,
    managed.browserSession,
    managed.cdpUrl,
    ["eval", `window.name = ${JSON.stringify(`pi:${managed.browserSession}`)}`],
    { signal, timeout: 10000 },
  ).catch(() => {
    // Marker is optional.
  });

  return index;
}

async function ensureManagedSession(
  pi: ExtensionAPI,
  ctx: any,
  signal: AbortSignal | undefined,
): Promise<ManagedSession> {
  const piSessionKey = getPiSessionKey(ctx);
  const cdpUrl = await ensureCdpAvailable(pi, ctx);

  let managed = managedSessions.get(piSessionKey);

  if (!managed) {
    managed = {
      piSessionKey,
      browserSession: generateBrowserSessionName(piSessionKey),
      cdpUrl,
      tabIndex: -1,
    };

    managed.tabIndex = await createFreshManagedTab(pi, managed, signal);
    managedSessions.set(piSessionKey, managed);
    updateBrowserStatus(
      {
        phase: "connected",
        browserSession: managed.browserSession,
        tabIndex: managed.tabIndex,
        error: null,
      },
      ctx,
    );
    return managed;
  }

  managed.cdpUrl = cdpUrl;

  // Ensure we can switch back to the managed tab. If not, create a fresh one.
  try {
    await runAgentBrowserJson(
      pi,
      managed.browserSession,
      managed.cdpUrl,
      ["tab", String(managed.tabIndex)],
      { signal, timeout: 10000 },
    );
  } catch {
    managed.tabIndex = await createFreshManagedTab(pi, managed, signal);
  }

  updateBrowserStatus(
    {
      phase: "connected",
      browserSession: managed.browserSession,
      tabIndex: managed.tabIndex,
      error: null,
    },
    ctx,
  );

  return managed;
}

async function closeManagedSessionTab(
  pi: ExtensionAPI,
  managed: ManagedSession,
): Promise<void> {
  try {
    await runAgentBrowserJson(
      pi,
      managed.browserSession,
      managed.cdpUrl,
      ["tab", String(managed.tabIndex)],
      { timeout: 10000 },
    );

    await runAgentBrowserJson(
      pi,
      managed.browserSession,
      managed.cdpUrl,
      ["tab", "close", String(managed.tabIndex)],
      { timeout: 10000 },
    );
  } catch {
    // Best-effort cleanup; tab may already be gone.
  }

  // Also ask agent-browser to close its daemon session.
  await pi
    .exec("agent-browser", ["--session", managed.browserSession, "--json", "close"], {
      timeout: 5000,
    })
    .catch(() => {
      // Ignore cleanup failures.
    });
}

function closeManagedSessionTabSync(managed: ManagedSession): void {
  try {
    spawnSync(
      "agent-browser",
      [
        "--session",
        managed.browserSession,
        "--cdp",
        managed.cdpUrl,
        "--json",
        "tab",
        "close",
        String(managed.tabIndex),
      ],
      { stdio: "ignore", timeout: 8000 },
    );
  } catch {
    // Ignore sync cleanup failures.
  }

  try {
    spawnSync(
      "agent-browser",
      ["--session", managed.browserSession, "--json", "close"],
      { stdio: "ignore", timeout: 5000 },
    );
  } catch {
    // Ignore sync cleanup failures.
  }
}

function formatCommandOutput(action: string, data: unknown): string {
  if (data === undefined || data === null) return "(no output)";

  if (action === "snapshot") {
    const snapshot = (data as { snapshot?: unknown })?.snapshot;
    if (typeof snapshot === "string") return snapshot;
  }

  if (typeof data === "string") return data;
  if (typeof data === "number" || typeof data === "boolean") return String(data);

  try {
    return JSON.stringify(data, null, 2);
  } catch {
    return String(data);
  }
}

async function ensureInstalled(pi: ExtensionAPI, ctx: any): Promise<boolean> {
  const check = await pi.exec("which", ["agent-browser"], { timeout: 5000 });
  if (check.code === 0 && check.stdout.trim()) {
    return true;
  }

  if (!ctx.hasUI) {
    return false;
  }

  const ok = await ctx.ui.confirm(
    "agent-browser not found",
    "Install agent-browser globally with npm? (npm install -g agent-browser)",
  );
  if (!ok) {
    return false;
  }

  ctx.ui.notify("Installing agent-browser...", "info");
  const install = await pi.exec("npm", ["install", "-g", "agent-browser"], {
    timeout: 120000,
  });
  if (install.code !== 0) {
    ctx.ui.notify(`Installation failed: ${install.stderr}`, "error");
    return false;
  }

  ctx.ui.notify("Downloading Chromium...", "info");
  const chromium = await pi.exec("agent-browser", ["install"], { timeout: 120000 });
  if (chromium.code !== 0) {
    ctx.ui.notify(`Chromium install failed: ${chromium.stderr}`, "error");
    return false;
  }

  ctx.ui.notify("agent-browser installed successfully!", "info");
  return true;
}

export default function browserExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "browser",
    label: "Browser",
    description: TOOL_DESCRIPTION,
    parameters: Type.Object({
      command: Type.String({
        description: "agent-browser command (tab/session/connect managed automatically)",
      }),
    }),

    renderCall(args: { command: string }, theme: any) {
      const text =
        theme.fg("toolTitle", theme.bold("browser ")) +
        theme.fg("accent", args.command);
      return new Text(text, 0, 0);
    },

    renderResult(
      result: any,
      { expanded, isPartial }: { expanded: boolean; isPartial: boolean },
      theme: any,
    ) {
      if (isPartial) {
        return new Text(theme.fg("warning", "Running..."), 0, 0);
      }

      const details = result.details || {};

      if (result.isError || details.error) {
        const errorText = details.error || result.content?.[0]?.text || "Error";
        return new Text(theme.fg("error", errorText), 0, 0);
      }

      const action = details.action || "";
      const content = result.content?.[0]?.text || "";

      if (action === "screenshot") {
        return new Text(
          theme.fg(
            "success",
            `Screenshot saved: ${details.screenshotPath || "unknown"}`,
          ),
          0,
          0,
        );
      }

      if (action === "snapshot") {
        const refMatches = [
          ...content.matchAll(/(?:@|\[ref=)(e\d+)/g),
        ].map((m) => m[1]);
        const refCount = new Set(refMatches).size;

        let text = theme.fg("success", `${refCount} interactive elements`);
        if (details.truncated) {
          text += theme.fg("warning", " (truncated)");
        }
        if (expanded) {
          text += "\n" + theme.fg("dim", content);
        }
        return new Text(text, 0, 0);
      }

      if (expanded) {
        return new Text(theme.fg("dim", content), 0, 0);
      }

      const firstLine = content.split("\n")[0] || "(no output)";
      const truncated = content.includes("\n") ? "…" : "";
      return new Text(theme.fg("dim", firstLine + truncated), 0, 0);
    },

    async execute(toolCallId, params, signal, onUpdate, ctx) {
      setBrowserUiContext(ctx);

      let parts: string[];
      try {
        parts = splitCommand(params.command);
      } catch (error: any) {
        updateBrowserStatus({ phase: "error", error: error?.message || "Invalid browser command" }, ctx);
        return {
          content: [{ type: "text", text: error?.message || "Invalid browser command" }],
          details: { error: error?.message || "Invalid browser command" },
          isError: true,
        };
      }

      if (parts.length === 0) {
        updateBrowserStatus({ phase: "error", error: "Browser command cannot be empty" }, ctx);
        return {
          content: [{ type: "text", text: "Browser command cannot be empty" }],
          details: { error: "empty-command" },
          isError: true,
        };
      }

      const action = parts[0].toLowerCase();
      updateBrowserStatus(
        {
          runningAction: action,
          error: null,
          phase: managedSessions.size > 0 ? "connected" : "connecting",
        },
        ctx,
      );

      if (RESERVED_COMMANDS.has(action)) {
        updateBrowserStatus(
          {
            runningAction: null,
            phase: "error",
            error: `Command '${action}' is managed automatically by this extension.`,
          },
          ctx,
        );
        return {
          content: [
            {
              type: "text",
              text: `Command '${action}' is managed automatically by this extension. Use open/snapshot/click/fill/etc.`,
            },
          ],
          details: { error: `reserved-command:${action}` },
          isError: true,
        };
      }

      const installed = await ensureInstalled(pi, ctx);
      if (!installed) {
        updateBrowserStatus(
          {
            runningAction: null,
            phase: "error",
            error: "agent-browser is not installed",
          },
          ctx,
        );
        return {
          content: [
            {
              type: "text",
              text: "agent-browser is not installed. Install manually with: npm install -g agent-browser && agent-browser install",
            },
          ],
          details: { error: "not-installed" },
          isError: true,
        };
      }

      const piSessionKey = getPiSessionKey(ctx);

      try {
        const managed = await ensureManagedSession(pi, ctx, signal);

        // Manual close: close this session's tab + daemon session.
        if (action === "close") {
          await closeManagedSessionTab(pi, managed);
          managedSessions.delete(piSessionKey);
          syncStatusFromManagedSessions(ctx, piSessionKey);
          updateBrowserStatus({ runningAction: null }, ctx);
          return {
            content: [{ type: "text", text: "Closed this session's browser tab" }],
            details: {
              action,
              command: params.command,
              browserSession: managed.browserSession,
              tabIndex: managed.tabIndex,
            },
          };
        }

        // Keep this pi session pinned to its dedicated tab.
        await runAgentBrowserJson(
          pi,
          managed.browserSession,
          managed.cdpUrl,
          ["tab", String(managed.tabIndex)],
          { signal, timeout: 10000 },
        );

        const { response } = await runAgentBrowserJson(
          pi,
          managed.browserSession,
          managed.cdpUrl,
          parts,
          { signal, timeout: 60000 },
        );

        // Screenshot: return inline image for vision models.
        if (action === "screenshot") {
          const screenshotPath =
            (response.data as { path?: string } | undefined)?.path || null;

          if (screenshotPath) {
            try {
              const imageData = readFileSync(screenshotPath);
              const base64 = imageData.toString("base64");
              const ext = extname(screenshotPath).toLowerCase();
              const mimeType =
                ext === ".jpg" || ext === ".jpeg"
                  ? "image/jpeg"
                  : ext === ".webp"
                    ? "image/webp"
                    : "image/png";

              updateBrowserStatus(
                {
                  phase: "connected",
                  browserSession: managed.browserSession,
                  tabIndex: managed.tabIndex,
                  runningAction: null,
                  error: null,
                },
                ctx,
              );

              return {
                content: [
                  { type: "text", text: `Screenshot saved: ${screenshotPath}` },
                  { type: "image", data: base64, mimeType },
                ],
                details: {
                  command: params.command,
                  action,
                  screenshotPath,
                  browserSession: managed.browserSession,
                  tabIndex: managed.tabIndex,
                },
              };
            } catch (error: any) {
              updateBrowserStatus(
                {
                  phase: "error",
                  runningAction: null,
                  error: `Screenshot read failed: ${error?.message || String(error)}`,
                },
                ctx,
              );

              return {
                content: [
                  {
                    type: "text",
                    text: `Screenshot saved to ${screenshotPath} but could not read file: ${error?.message || error}`,
                  },
                ],
                details: {
                  command: params.command,
                  action,
                  screenshotPath,
                  readError: error?.message || String(error),
                },
              };
            }
          }
        }

        const output = formatCommandOutput(action, response.data);

        const truncation = truncateHead(output, {
          maxLines: DEFAULT_MAX_LINES,
          maxBytes: DEFAULT_MAX_BYTES,
        });

        let resultText = truncation.content;

        if (truncation.truncated) {
          const tempFile = writeTempFile(output, action);
          resultText += `\n\n[Output truncated: ${truncation.outputLines} of ${truncation.totalLines} lines`;
          resultText += ` (${formatSize(truncation.outputBytes)} of ${formatSize(
            truncation.totalBytes,
          )}).`;
          resultText += ` Full output saved to: ${tempFile}]`;
        }

        updateBrowserStatus(
          {
            phase: "connected",
            browserSession: managed.browserSession,
            tabIndex: managed.tabIndex,
            runningAction: null,
            error: null,
          },
          ctx,
        );

        return {
          content: [{ type: "text", text: resultText || "(no output)" }],
          details: {
            command: params.command,
            action,
            truncated: truncation.truncated,
            browserSession: managed.browserSession,
            tabIndex: managed.tabIndex,
            cdpUrl: managed.cdpUrl,
          },
        };
      } catch (error: any) {
        const errorText = error?.message || String(error);
        updateBrowserStatus(
          {
            phase: "error",
            runningAction: null,
            error: errorText,
          },
          ctx,
        );
        return {
          content: [{ type: "text", text: errorText }],
          details: { error: errorText, command: params.command, action },
          isError: true,
        };
      }
    },
  });

  pi.registerCommand("browser", {
    description: "Manage browser session (usage: /browser exit)",
    handler: async (args, ctx) => {
      setBrowserUiContext(ctx);

      const action = (args || "").trim().toLowerCase();
      if (!action || action === "help") {
        if (ctx.hasUI) {
          ctx.ui.notify("Usage: /browser exit", "info");
        }
        return;
      }

      if (action !== "exit" && action !== "close") {
        if (ctx.hasUI) {
          ctx.ui.notify("Usage: /browser exit", "warning");
        }
        return;
      }

      const piSessionKey = getPiSessionKey(ctx);
      const managed = managedSessions.get(piSessionKey);

      if (!managed) {
        syncStatusFromManagedSessions(ctx, piSessionKey);
        if (ctx.hasUI) {
          ctx.ui.notify("No active browser session in this tab", "info");
        }
        return;
      }

      await closeManagedSessionTab(pi, managed);
      managedSessions.delete(piSessionKey);
      syncStatusFromManagedSessions(ctx, piSessionKey);
      updateBrowserStatus({ runningAction: null, error: null }, ctx);

      if (ctx.hasUI) {
        ctx.ui.notify("Browser session closed", "info");
      }
    },
  });

  // Start fresh on session changes (/new, /resume, /fork):
  // close any tabs owned by the previous in-process session state.
  const resetManagedSessions = async (ctx?: any) => {
    const states = [...managedSessions.values()];
    for (const managed of states) {
      await closeManagedSessionTab(pi, managed);
      managedSessions.delete(managed.piSessionKey);
    }
    syncStatusFromManagedSessions(ctx);
  };

  pi.on("session_start", async (_event, ctx) => {
    setBrowserUiContext(ctx);
    syncStatusFromManagedSessions(ctx);
  });

  pi.on("session_switch", async (_event, ctx) => {
    setBrowserUiContext(ctx);
    await resetManagedSessions(ctx);
  });

  pi.on("session_fork", async (_event, ctx) => {
    setBrowserUiContext(ctx);
    await resetManagedSessions(ctx);
  });

  // Print/RPC modes can terminate quickly after a turn and may not wait for
  // async shutdown cleanup. If there's no UI, perform synchronous cleanup.
  pi.on("agent_end", async (_event, ctx) => {
    if (!ctx.hasUI) {
      const states = [...managedSessions.values()];
      for (const managed of states) {
        closeManagedSessionTabSync(managed);
        managedSessions.delete(managed.piSessionKey);
      }
      syncStatusFromManagedSessions(ctx);
    }
  });

  // Clean up all managed tabs when this pi process/session shuts down.
  pi.on("session_shutdown", async (_event, ctx) => {
    await resetManagedSessions(ctx);
    if (ctx?.hasUI) {
      ctx.ui.setStatus("browser", undefined);
    }
  });
}
