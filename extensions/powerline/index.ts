import type { ExtensionAPI, ReadonlyFooterDataProvider, Theme } from "@mariozechner/pi-coding-agent";
import type { AssistantMessage } from "@mariozechner/pi-ai";
import { visibleWidth } from "@mariozechner/pi-tui";
import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";

import type { ColorScheme, SegmentContext, StatusLinePreset, StatusLineSegmentId, UsageStats, SubUsageSnapshot } from "./types.js";
import { getPreset, PRESETS } from "./presets.js";
import { getSeparator } from "./separators.js";
import { renderSegment } from "./segments.js";
import { getGitStatus, invalidateGitStatus, invalidateGitBranch } from "./git-status.js";
import { ansi, getFgAnsiCode } from "./colors.js";
import { WelcomeComponent, WelcomeHeader, discoverLoadedCounts, getRecentSessions } from "./welcome.js";
import { getDefaultColors } from "./theme.js";
import { 
  initVibeManager, 
  onVibeBeforeAgentStart, 
  onVibeAgentStart, 
  onVibeAgentEnd,
  onVibeToolCall,
  getVibeTheme,
  setVibeTheme,
  getVibeModel,
  setVibeModel,
  getVibeMode,
  setVibeMode,
  hasVibeFile,
  getVibeFileCount,
  generateVibesBatch,
} from "./working-vibes.js";

// ═══════════════════════════════════════════════════════════════════════════
// Configuration
// ═══════════════════════════════════════════════════════════════════════════

interface PowerlineConfig {
  preset: StatusLinePreset;
}

let config: PowerlineConfig = {
  preset: "default",
};

// Check if quietStartup is enabled in settings
function isQuietStartup(): boolean {
  const homeDir = process.env.HOME || process.env.USERPROFILE || "";
  const settingsPath = join(homeDir, ".pi", "agent", "settings.json");
  
  try {
    if (existsSync(settingsPath)) {
      const settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
      return settings.quietStartup === true;
    }
  } catch {}
  
  return false;
}

// ═══════════════════════════════════════════════════════════════════════════
// Usage Tracking (24h rolling window)
// ═══════════════════════════════════════════════════════════════════════════

interface UsageEntry extends UsageStats {
  timestamp: number;
}

const USAGE_WINDOW_MS = 24 * 60 * 60 * 1000;

function getUsageStorePath(): string {
  const homeDir = process.env.HOME || process.env.USERPROFILE || "";
  return join(homeDir, ".pi", "agent", "usage", "powerline-footer.json");
}

function loadUsageHistory(): UsageEntry[] {
  const usagePath = getUsageStorePath();
  try {
    if (existsSync(usagePath)) {
      const raw = readFileSync(usagePath, "utf-8");
      const data = JSON.parse(raw);
      if (Array.isArray(data)) {
        return data as UsageEntry[];
      }
    }
  } catch {
    return [];
  }
  return [];
}

function saveUsageHistory(entries: UsageEntry[]): void {
  const usagePath = getUsageStorePath();
  const dir = dirname(usagePath);
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(usagePath, JSON.stringify(entries, null, 2), "utf-8");
  } catch {
    // Ignore file write errors
  }
}

function pruneUsageHistory(entries: UsageEntry[], now: number): UsageEntry[] {
  const cutoff = now - USAGE_WINDOW_MS;
  return entries.filter(entry => entry.timestamp >= cutoff);
}

function recordUsageEntry(entry: UsageEntry): void {
  const now = entry.timestamp;
  const history = pruneUsageHistory(loadUsageHistory(), now);
  history.push(entry);
  saveUsageHistory(history);
}

function getUsageStats24h(now: number): UsageStats {
  const history = pruneUsageHistory(loadUsageHistory(), now);
  return history.reduce<UsageStats>(
    (acc, entry) => ({
      input: acc.input + entry.input,
      output: acc.output + entry.output,
      cacheRead: acc.cacheRead + entry.cacheRead,
      cacheWrite: acc.cacheWrite + entry.cacheWrite,
      cost: acc.cost + entry.cost,
    }),
    { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
  );
}

interface OverageDayEntry extends UsageStats {
  resetAt: string;
  day: string;
  updatedAt: number;
}

const OVERAGE_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

function getOverageStorePath(): string {
  const homeDir = process.env.HOME || process.env.USERPROFILE || "";
  return join(homeDir, ".pi", "agent", "usage", "powerline-overage.json");
}

function loadOverageHistory(): OverageDayEntry[] {
  const overagePath = getOverageStorePath();
  try {
    if (existsSync(overagePath)) {
      const raw = readFileSync(overagePath, "utf-8");
      const data = JSON.parse(raw);
      if (Array.isArray(data)) {
        return data as OverageDayEntry[];
      }
    }
  } catch {
    return [];
  }
  return [];
}

function saveOverageHistory(entries: OverageDayEntry[]): void {
  const overagePath = getOverageStorePath();
  const dir = dirname(overagePath);
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(overagePath, JSON.stringify(entries, null, 2), "utf-8");
  } catch {
    // Ignore file write errors
  }
}

function pruneOverageHistory(entries: OverageDayEntry[], now: number): OverageDayEntry[] {
  const cutoff = now - OVERAGE_RETENTION_MS;
  return entries.filter((entry) => entry.updatedAt >= cutoff);
}

function utcDay(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(0, 10);
}

function normalizeResetKey(resetAt?: string): string | undefined {
  if (!resetAt) return undefined;
  const date = new Date(resetAt);
  if (!Number.isFinite(date.getTime())) {
    return resetAt;
  }

  // Some providers jitter resetAt by a second between fetches.
  // Normalize to minute precision so one reset window remains stable.
  date.setUTCSeconds(0, 0);
  return date.toISOString();
}

function recordOverageEntry(resetAt: string, entry: UsageEntry): void {
  const now = entry.timestamp;
  const day = utcDay(now);
  const resetKey = normalizeResetKey(resetAt) ?? resetAt;
  const history = pruneOverageHistory(loadOverageHistory(), now);
  const existing = history.find((item) => {
    const itemResetKey = normalizeResetKey(item.resetAt) ?? item.resetAt;
    return itemResetKey === resetKey && item.day === day;
  });

  if (existing) {
    existing.input += entry.input;
    existing.output += entry.output;
    existing.cacheRead += entry.cacheRead;
    existing.cacheWrite += entry.cacheWrite;
    existing.cost += entry.cost;
    existing.updatedAt = now;
  } else {
    history.push({
      resetAt: resetKey,
      day,
      updatedAt: now,
      input: entry.input,
      output: entry.output,
      cacheRead: entry.cacheRead,
      cacheWrite: entry.cacheWrite,
      cost: entry.cost,
    });
  }

  saveOverageHistory(history);
}

function getOverageStats(resetAt?: string): UsageStats {
  const targetResetKey = normalizeResetKey(resetAt);
  if (!targetResetKey) {
    return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
  }

  const history = loadOverageHistory();
  return history.reduce<UsageStats>(
    (acc, entry) => {
      const entryResetKey = normalizeResetKey(entry.resetAt) ?? entry.resetAt;
      if (entryResetKey !== targetResetKey) {
        return acc;
      }
      return {
        input: acc.input + entry.input,
        output: acc.output + entry.output,
        cacheRead: acc.cacheRead + entry.cacheRead,
        cacheWrite: acc.cacheWrite + entry.cacheWrite,
        cost: acc.cost + entry.cost,
      };
    },
    { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
  );
}

function getWeekWindow(snapshot?: SubUsageSnapshot) {
  if (!snapshot || snapshot.windows.length === 0) return undefined;
  return snapshot.windows.find((window) => (window.label || "").trim().toLowerCase() === "week");
}

// ═══════════════════════════════════════════════════════════════════════════
// Status Line Builder
// ═══════════════════════════════════════════════════════════════════════════

/** Render a single segment and return its content with width */
function renderSegmentWithWidth(
  segId: StatusLineSegmentId,
  ctx: SegmentContext
): { content: string; width: number; visible: boolean } {
  const rendered = renderSegment(segId, ctx);
  if (!rendered.visible || !rendered.content) {
    return { content: "", width: 0, visible: false };
  }
  return { content: rendered.content, width: visibleWidth(rendered.content), visible: true };
}

/** Build content string from pre-rendered parts */
function buildContentFromParts(
  parts: string[],
  presetDef: ReturnType<typeof getPreset>,
  options?: { pad?: boolean }
): string {
  if (parts.length === 0) return "";
  const separatorDef = getSeparator(presetDef.separator);
  const sepAnsi = getFgAnsiCode("sep");
  const sep = separatorDef.left;
  const joined = parts.join(` ${sepAnsi}${sep}${ansi.reset} `) + ansi.reset;
  return options?.pad === false ? joined : ` ${joined} `;
}

/**
 * Responsive segment layout - fits segments into top bar, overflows to secondary row.
 * When terminal is wide enough, secondary segments move up to top bar.
 * When narrow, top bar segments overflow down to secondary row.
 */
function computeResponsiveLayout(
  ctx: SegmentContext,
  presetDef: ReturnType<typeof getPreset>,
  availableWidth: number
): { topContent: string; secondaryContent: string } {
  const separatorDef = getSeparator(presetDef.separator);
  const sepWidth = visibleWidth(separatorDef.left) + 2; // separator + spaces around it

  const renderGroup = (ids: StatusLineSegmentId[]) => {
    const parts: string[] = [];
    let width = 0;
    for (const segId of ids) {
      const { content, width: segWidth, visible } = renderSegmentWithWidth(segId, ctx);
      if (visible) {
        parts.push(content);
        width += segWidth + (parts.length > 1 ? sepWidth : 0);
      }
    }
    return { parts, width };
  };

  const left = renderGroup(presetDef.leftSegments);
  const right = renderGroup(presetDef.rightSegments);
  const secondary = renderGroup(presetDef.secondarySegments ?? []);

  if (left.parts.length === 0 && right.parts.length === 0 && secondary.parts.length === 0) {
    return { topContent: "", secondaryContent: "" };
  }

  const leftContent = buildContentFromParts(left.parts, presetDef);
  const rightContent = buildContentFromParts(right.parts, presetDef);
  const leftWidth = visibleWidth(leftContent);
  const rightWidth = visibleWidth(rightContent);

  // Right-align when both sides fit. Otherwise, fall back to overflow layout.
  if (leftWidth + rightWidth <= availableWidth && (leftWidth > 0 || rightWidth > 0)) {
    const gap = Math.max(0, availableWidth - leftWidth - rightWidth);
    const topContent = `${leftContent}${" ".repeat(gap)}${rightContent}`.trimEnd();
    return {
      topContent,
      secondaryContent: buildContentFromParts(secondary.parts, presetDef),
    };
  }

  // Fallback overflow layout (single flow + secondary row)
  const primaryIds = [...presetDef.leftSegments, ...presetDef.rightSegments];
  const secondaryIds = presetDef.secondarySegments ?? [];
  const allSegmentIds = [...primaryIds, ...secondaryIds];

  const renderedSegments: { id: StatusLineSegmentId; content: string; width: number }[] = [];
  for (const segId of allSegmentIds) {
    const { content, width, visible } = renderSegmentWithWidth(segId, ctx);
    if (visible) {
      renderedSegments.push({ id: segId, content, width });
    }
  }

  if (renderedSegments.length === 0) {
    return { topContent: "", secondaryContent: "" };
  }

  const baseOverhead = 2;
  let currentWidth = baseOverhead;
  let topSegments: string[] = [];
  let secondarySegments: string[] = [];
  let overflow = false;

  for (let i = 0; i < renderedSegments.length; i++) {
    const seg = renderedSegments[i];
    const neededWidth = seg.width + (topSegments.length > 0 ? sepWidth : 0);

    if (!overflow && currentWidth + neededWidth <= availableWidth) {
      topSegments.push(seg.content);
      currentWidth += neededWidth;
    } else {
      overflow = true;
      secondarySegments.push(seg.content);
    }
  }

  return {
    topContent: buildContentFromParts(topSegments, presetDef),
    secondaryContent: buildContentFromParts(secondarySegments, presetDef),
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Extension
// ═══════════════════════════════════════════════════════════════════════════

export default function powerlineFooter(pi: ExtensionAPI) {
  let enabled = true;
  let sessionStartTime = Date.now();
  let currentCtx: any = null;
  let footerDataRef: ReadonlyFooterDataProvider | null = null;
  let getThinkingLevelFn: (() => string) | null = null;
  let isStreaming = false;
  let tuiRef: any = null; // Store TUI reference for forcing re-renders
  let dismissWelcomeOverlay: (() => void) | null = null; // Callback to dismiss welcome overlay
  let welcomeHeaderActive = false; // Track if welcome header should be cleared on first input
  let welcomeOverlayShouldDismiss = false; // Track early dismissal request (before overlay setup completes)
  let lastRecordedMessageIndex = -1;
  let subUsage: SubUsageSnapshot | undefined;
  
  // Cache for responsive layout (shared between editor and widget for consistency)
  let lastLayoutWidth = 0;
  let lastLayoutResult: { topContent: string; secondaryContent: string } | null = null;
  let lastLayoutTimestamp = 0;

  // Track session start
  pi.on("session_start", async (_event, ctx) => {
    sessionStartTime = Date.now();
    currentCtx = ctx;
    lastRecordedMessageIndex = -1;
    subUsage = undefined;
    
    // Store thinking level getter if available
    if (typeof ctx.getThinkingLevel === 'function') {
      getThinkingLevelFn = () => ctx.getThinkingLevel();
    }
    
    // Initialize vibe manager (needs modelRegistry from ctx)
    initVibeManager(ctx);
    
    if (enabled && ctx.hasUI) {
      setupCustomEditor(ctx);
      // quietStartup: true → compact header, otherwise → full overlay
      if (isQuietStartup()) {
        setupWelcomeHeader(ctx);
      } else {
        setupWelcomeOverlay(ctx);
      }
    }

    requestSubCoreState();
  });
  
  // Update context when model changes (via /model command, Ctrl+P, etc.)
  pi.on("model_select", async (_event, ctx) => {
    currentCtx = ctx;
    // Invalidate layout cache since model display may change
    lastLayoutResult = null;
    // Request re-render to show updated model
    tuiRef?.requestRender();
    requestSubCoreState();
  });

  pi.events.on("sub-core:update-current", (payload) => {
    const state = payload as { state?: { usage?: SubUsageSnapshot } };
    updateSubUsage(state.state?.usage);
  });

  pi.events.on("sub-core:ready", (payload) => {
    const state = payload as { state?: { usage?: SubUsageSnapshot } };
    updateSubUsage(state.state?.usage);
  });

  // Check if a bash command might change git branch
  const mightChangeGitBranch = (cmd: string): boolean => {
    const gitBranchPatterns = [
      /\bgit\s+(checkout|switch|branch\s+-[dDmM]|merge|rebase|pull|reset|worktree)/,
      /\bgit\s+stash\s+(pop|apply)/,
    ];
    return gitBranchPatterns.some(p => p.test(cmd));
  };

  // Invalidate git status on file changes, trigger re-render on potential branch changes
  pi.on("tool_result", async (event, _ctx) => {
    if (event.toolName === "write" || event.toolName === "edit") {
      invalidateGitStatus();
    }
    // Check for bash commands that might change git branch
    if (event.toolName === "bash" && event.input?.command) {
      const cmd = String(event.input.command);
      if (mightChangeGitBranch(cmd)) {
        // Invalidate caches since working tree state changes with branch
        invalidateGitStatus();
        invalidateGitBranch();
        // Small delay to let git update, then re-render
        setTimeout(() => tuiRef?.requestRender(), 100);
      }
    }
  });

  // Also catch user escape commands (! prefix)
  // Note: This fires BEFORE execution, so we use a longer delay and multiple re-renders
  // to ensure we catch the update after the command completes.
  pi.on("user_bash", async (event, _ctx) => {
    if (mightChangeGitBranch(event.command)) {
      // Invalidate immediately so next render fetches fresh data
      invalidateGitStatus();
      invalidateGitBranch();
      // Multiple staggered re-renders to catch fast and slow commands
      setTimeout(() => tuiRef?.requestRender(), 100);
      setTimeout(() => tuiRef?.requestRender(), 300);
      setTimeout(() => tuiRef?.requestRender(), 500);
    }
  });

  // Generate themed working message before agent starts (has access to user's prompt)
  pi.on("before_agent_start", async (event, ctx) => {
    if (ctx.hasUI) {
      onVibeBeforeAgentStart(event.prompt, ctx.ui.setWorkingMessage);
    }
  });

  // Track streaming state (footer only shows status during streaming)
  // Also dismiss welcome when agent starts responding (handles `p "command"` case)
  pi.on("agent_start", async (_event, ctx) => {
    isStreaming = true;
    onVibeAgentStart();
    dismissWelcome(ctx);
  });

  // Also dismiss on tool calls (agent is working) + refresh vibe if rate limit allows
  pi.on("tool_call", async (event, ctx) => {
    dismissWelcome(ctx);
    if (ctx.hasUI) {
      // Extract recent agent context from session for richer vibe generation
      const agentContext = getRecentAgentContext(ctx);
      onVibeToolCall(event.toolName, event.input, ctx.ui.setWorkingMessage, agentContext);
    }
  });
  
  function recordLatestUsage(ctx: any) {
    const sessionEvents = ctx.sessionManager?.getBranch?.() ?? [];
    for (let i = sessionEvents.length - 1; i >= 0; i--) {
      const e = sessionEvents[i];
      if (e.type === "message" && e.message?.role === "assistant") {
        const m = e.message as AssistantMessage;
        if (m.stopReason === "error" || m.stopReason === "aborted") {
          continue;
        }
        if (i <= lastRecordedMessageIndex) {
          return;
        }
        lastRecordedMessageIndex = i;
        const usageEntry: UsageEntry = {
          timestamp: Date.now(),
          input: m.usage.input,
          output: m.usage.output,
          cacheRead: m.usage.cacheRead,
          cacheWrite: m.usage.cacheWrite,
          cost: m.usage.cost.total,
        };

        recordUsageEntry(usageEntry);

        const weekWindow = getWeekWindow(subUsage);
        const weekPct = weekWindow && Number.isFinite(weekWindow.usedPercent)
          ? Math.max(0, Math.min(100, Math.round(weekWindow.usedPercent)))
          : 0;

        if (weekWindow?.resetAt && weekPct >= 100) {
          recordOverageEntry(weekWindow.resetAt, usageEntry);
        }

        return;
      }
    }
  }

  function updateSubUsage(next?: SubUsageSnapshot): void {
    subUsage = next;
    lastLayoutResult = null;
    tuiRef?.requestRender();
  }

  function requestSubCoreState(timeoutMs = 1000): void {
    let resolved = false;
    const timer = setTimeout(() => {
      if (resolved) return;
      resolved = true;
    }, timeoutMs);

    const request = {
      type: "current",
      reply: (payload: { state?: { usage?: SubUsageSnapshot } }) => {
        if (resolved) return;
        resolved = true;
        clearTimeout(timer);
        updateSubUsage(payload?.state?.usage);
      },
    };

    pi.events.emit("sub-core:request", request);
  }

  // Helper to extract recent agent response text (skipping thinking blocks)
  function getRecentAgentContext(ctx: any): string | undefined {
    const sessionEvents = ctx.sessionManager?.getBranch?.() ?? [];
    
    // Find the most recent assistant message
    for (let i = sessionEvents.length - 1; i >= 0; i--) {
      const e = sessionEvents[i];
      if (e.type === "message" && e.message?.role === "assistant") {
        const content = e.message.content;
        if (!Array.isArray(content)) continue;
        
        // Extract text content, skip thinking blocks
        for (const block of content) {
          if (block.type === "text" && block.text) {
            // Return first ~200 chars of non-empty text
            const text = block.text.trim();
            if (text.length > 0) {
              return text.slice(0, 200);
            }
          }
        }
      }
    }
    return undefined;
  }

  // Helper to dismiss welcome overlay/header
  function dismissWelcome(ctx: any) {
    if (dismissWelcomeOverlay) {
      dismissWelcomeOverlay();
      dismissWelcomeOverlay = null;
    } else {
      // Overlay not set up yet (100ms delay) - mark for immediate dismissal when it does
      welcomeOverlayShouldDismiss = true;
    }
    if (welcomeHeaderActive) {
      welcomeHeaderActive = false;
      ctx.ui.setHeader(undefined);
    }
  }

  pi.on("agent_end", async (_event, ctx) => {
    isStreaming = false;
    recordLatestUsage(ctx);
    if (ctx.hasUI) {
      onVibeAgentEnd(ctx.ui.setWorkingMessage); // working-vibes internal state + reset message
    }
  });

  // Dismiss welcome overlay/header on first user message
  pi.on("user_message", async (_event, ctx) => {
    dismissWelcome(ctx);
  });

  // Command to toggle/configure
  pi.registerCommand("powerline", {
    description: "Configure powerline status (toggle, preset)",
    handler: async (args, ctx) => {
      // Update context reference (command ctx may have more methods)
      currentCtx = ctx;
      
      if (!args) {
        // Toggle
        enabled = !enabled;
        if (enabled) {
          setupCustomEditor(ctx);
          ctx.ui.notify("Powerline enabled", "info");
        } else {
          // Clear all custom UI components
          ctx.ui.setEditorComponent(undefined);
          ctx.ui.setFooter(undefined);
          ctx.ui.setHeader(undefined);
          ctx.ui.setWidget("powerline-secondary", undefined);
          ctx.ui.setWidget("powerline-status", undefined);
          footerDataRef = null;
          tuiRef = null;
          // Clear layout cache
          lastLayoutResult = null;
          ctx.ui.notify("Defaults restored", "info");
        }
        return;
      }

      // Check if args is a preset name
      const preset = args.trim().toLowerCase() as StatusLinePreset;
      if (preset in PRESETS) {
        config.preset = preset;
        // Invalidate layout cache since preset changed
        lastLayoutResult = null;
        if (enabled) {
          setupCustomEditor(ctx);
        }
        ctx.ui.notify(`Preset set to: ${preset}`, "info");
        return;
      }

      // Show available presets
      const presetList = Object.keys(PRESETS).join(", ");
      ctx.ui.notify(`Available presets: ${presetList}`, "info");
    },
  });

  // Command to set working message theme
  pi.registerCommand("vibe", {
    description: "Set working message theme. Usage: /vibe [theme|off|mode|model|generate]",
    handler: async (args, ctx) => {
      const parts = args?.trim().split(/\s+/) || [];
      const subcommand = parts[0]?.toLowerCase();
      
      // No args: show current status
      if (!args || !args.trim()) {
        const theme = getVibeTheme();
        const mode = getVibeMode();
        const model = getVibeModel();
        let status = `Vibe: ${theme || "off"} | Mode: ${mode} | Model: ${model}`;
        if (theme && mode === "file") {
          const count = getVibeFileCount(theme);
          status += count > 0 ? ` | File: ${count} vibes` : " | File: not found";
        }
        ctx.ui.notify(status, "info");
        return;
      }
      
      // /vibe model [spec] - show or set model
      if (subcommand === "model") {
        const modelSpec = parts.slice(1).join(" ");
        if (!modelSpec) {
          ctx.ui.notify(`Current vibe model: ${getVibeModel()}`, "info");
          return;
        }
        // Validate format (provider/modelId)
        if (!modelSpec.includes("/")) {
          ctx.ui.notify("Invalid model format. Use: provider/modelId (e.g., anthropic/claude-haiku-4-5)", "error");
          return;
        }
        setVibeModel(modelSpec);
        ctx.ui.notify(`Vibe model set to: ${modelSpec}`, "info");
        return;
      }
      
      // /vibe mode [generate|file] - show or set mode
      if (subcommand === "mode") {
        const newMode = parts[1]?.toLowerCase();
        if (!newMode) {
          ctx.ui.notify(`Current vibe mode: ${getVibeMode()}`, "info");
          return;
        }
        if (newMode !== "generate" && newMode !== "file") {
          ctx.ui.notify("Invalid mode. Use: generate or file", "error");
          return;
        }
        // Check if file exists when switching to file mode
        const theme = getVibeTheme();
        if (newMode === "file" && theme && !hasVibeFile(theme)) {
          ctx.ui.notify(`No vibe file for "${theme}". Run /vibe generate ${theme} first`, "error");
          return;
        }
        setVibeMode(newMode);
        ctx.ui.notify(`Vibe mode set to: ${newMode}`, "info");
        return;
      }
      
      // /vibe generate <theme> [count] - generate vibes and save to file
      if (subcommand === "generate") {
        const theme = parts[1];
        const count = parseInt(parts[2]) || 100;
        
        if (!theme) {
          ctx.ui.notify("Usage: /vibe generate <theme> [count]", "error");
          return;
        }
        
        ctx.ui.notify(`Generating ${count} vibes for "${theme}"...`, "info");
        
        const result = await generateVibesBatch(theme, count);
        
        if (result.success) {
          ctx.ui.notify(`Generated ${result.count} vibes for "${theme}" → ${result.filePath}`, "info");
        } else {
          ctx.ui.notify(`Failed to generate vibes: ${result.error}`, "error");
        }
        return;
      }
      
      // /vibe off - disable
      if (subcommand === "off") {
        setVibeTheme(null);
        ctx.ui.notify("Vibe disabled", "info");
        return;
      }
      
      // /vibe <theme> - set theme (preserve original casing)
      setVibeTheme(args.trim());
      const mode = getVibeMode();
      const theme = args.trim();
      if (mode === "file" && !hasVibeFile(theme)) {
        ctx.ui.notify(`Vibe set to: ${theme} (file mode, but no file found - run /vibe generate ${theme})`, "warning");
      } else {
        ctx.ui.notify(`Vibe set to: ${theme}`, "info");
      }
    },
  });

  function buildSegmentContext(ctx: any, width: number, theme: Theme): SegmentContext {
    const presetDef = getPreset(config.preset);
    const colors: ColorScheme = presetDef.colors ?? getDefaultColors();

    // Build usage stats and get thinking level from session
    let input = 0, output = 0, cacheRead = 0, cacheWrite = 0, cost = 0;
    let lastAssistant: AssistantMessage | undefined;
    let thinkingLevelFromSession = "off";
    
    const sessionEvents = ctx.sessionManager?.getBranch?.() ?? [];
    for (const e of sessionEvents) {
      // Check for thinking level change entries
      if (e.type === "thinking_level_change" && e.thinkingLevel) {
        thinkingLevelFromSession = e.thinkingLevel;
      }
      if (e.type === "message" && e.message.role === "assistant") {
        const m = e.message as AssistantMessage;
        if (m.stopReason === "error" || m.stopReason === "aborted") {
          continue;
        }
        input += m.usage.input;
        output += m.usage.output;
        cacheRead += m.usage.cacheRead;
        cacheWrite += m.usage.cacheWrite;
        cost += m.usage.cost.total;
        lastAssistant = m;
      }
    }

    // Calculate context percentage (total tokens used in last turn)
    const contextTokens = lastAssistant
      ? lastAssistant.usage.input + lastAssistant.usage.output +
        lastAssistant.usage.cacheRead + lastAssistant.usage.cacheWrite
      : 0;
    const contextWindow = ctx.model?.contextWindow || 0;
    const contextPercent = contextWindow > 0 ? (contextTokens / contextWindow) * 100 : 0;

    // Get git status (cached)
    const gitBranch = footerDataRef?.getGitBranch() ?? null;
    const gitStatus = getGitStatus(gitBranch);

    // Check if using OAuth subscription
    const usingSubscription = ctx.model
      ? ctx.modelRegistry?.isUsingOAuth?.(ctx.model) ?? false
      : false;

    const usageStats24h = getUsageStats24h(Date.now());
    const weekWindow = getWeekWindow(subUsage);
    const overageStats = getOverageStats(weekWindow?.resetAt);

    return {
      model: ctx.model,
      thinkingLevel: thinkingLevelFromSession || getThinkingLevelFn?.() || "off",
      sessionId: ctx.sessionManager?.getSessionId?.(),
      usageStats: { input, output, cacheRead, cacheWrite, cost },
      usageStats24h,
      overageStats,
      subUsage,
      contextPercent,
      contextWindow,
      autoCompactEnabled: ctx.settingsManager?.getCompactionSettings?.()?.enabled ?? true,
      usingSubscription,
      sessionStartTime,
      git: gitStatus,
      extensionStatuses: footerDataRef?.getExtensionStatuses() ?? new Map(),
      options: presetDef.segmentOptions ?? {},
      width,
      theme,
      colors,
    };
  }

  /**
   * Get cached responsive layout or compute fresh one.
   * Layout is cached per render cycle (same width = same layout).
   */
  function getResponsiveLayout(width: number, theme: Theme): { topContent: string; secondaryContent: string } {
    const now = Date.now();
    // Cache is valid if same width and within 50ms (same render cycle)
    if (lastLayoutResult && lastLayoutWidth === width && now - lastLayoutTimestamp < 50) {
      return lastLayoutResult;
    }
    
    const presetDef = getPreset(config.preset);
    const segmentCtx = buildSegmentContext(currentCtx, width, theme);
    // Available width for status bar content (no fill, full width)
    const topBarAvailable = width;
    
    lastLayoutWidth = width;
    lastLayoutResult = computeResponsiveLayout(segmentCtx, presetDef, topBarAvailable);
    lastLayoutTimestamp = now;
    
    return lastLayoutResult;
  }

  function setupCustomEditor(ctx: any) {
    // Import CustomEditor dynamically and create wrapper
    import("@mariozechner/pi-coding-agent").then(({ CustomEditor }) => {
      ctx.ui.setEditorComponent((tui: any, editorTheme: any, keybindings: any) => {
        // Create custom editor that overrides render for status bar below content
        const editor = new CustomEditor(tui, editorTheme, keybindings);
        
        // Override handleInput to dismiss welcome on first keypress
        const originalHandleInput = editor.handleInput.bind(editor);
        editor.handleInput = (data: string) => {
          // Dismiss welcome overlay/header on first keypress (use setTimeout to avoid re-entrancy)
          setTimeout(() => dismissWelcome(ctx), 0);
          originalHandleInput(data);
        };
        
        // Store original render
        const originalRender = editor.render.bind(editor);
        
        // Override render: status bar, top rule, prompted content, bottom rule
        //  status content
        //  ──────────────────────────────────────
        //  > first line of input
        //    continuation lines
        //  ──────────────────────────────────────
        // + autocomplete items (if showing)
        editor.render = (width: number): string[] => {
          // Fall back to original render on extremely narrow terminals
          if (width < 10) {
            return originalRender(width);
          }
          
          const bc = (s: string) => `${getFgAnsiCode("sep")}${s}${ansi.reset}`;
          const prompt = `${ansi.getFgAnsi(200, 200, 200)}>${ansi.reset}`;
          
          // Content area: 3 chars for prompt prefix (" > " / "   ")
          const promptPrefix = ` ${prompt} `;
          const contPrefix = "   ";
          const contentWidth = Math.max(1, width - 3);
          const lines = originalRender(contentWidth);
          
          if (lines.length === 0 || !currentCtx) return lines;
          
          // Find bottom border (plain ─ or scroll indicator ─── ↓ N more)
          // Lines after it are autocomplete items
          let bottomBorderIndex = lines.length - 1;
          for (let i = lines.length - 1; i >= 1; i--) {
            const stripped = lines[i]?.replace(/\x1b\[[0-9;]*m/g, "") || "";
            if (stripped.length > 0 && /^─{3,}/.test(stripped)) {
              bottomBorderIndex = i;
              break;
            }
          }
          
          const result: string[] = [];
          
          // Status bar above top border
          const layout = getResponsiveLayout(width, ctx.ui.theme);
          result.push(layout.topContent);
          // Render overflow segments on a second status row when needed
          if (layout.secondaryContent) {
            result.push(layout.secondaryContent);
          }
          
          // Top border (plain rule, 1-char margins)
          result.push(" " + bc("─".repeat(width - 2)));
          
          // Content lines: first line gets "> " prompt, rest indented to match
          for (let i = 1; i < bottomBorderIndex; i++) {
            const prefix = i === 1 ? promptPrefix : contPrefix;
            result.push(`${prefix}${lines[i] || ""}`);
          }
          
          // If only had top/bottom borders (empty editor), show prompt
          if (bottomBorderIndex === 1) {
            result.push(`${promptPrefix}${" ".repeat(contentWidth)}`);
          }
          
          // Bottom border
          result.push(" " + bc("─".repeat(width - 2)));
          
          // Append any autocomplete lines that come after the bottom border
          for (let i = bottomBorderIndex + 1; i < lines.length; i++) {
            result.push(lines[i] || "");
          }
          
          return result;
        };
        
        return editor;
      });

      // Set up footer data provider access (needed for git branch, extension statuses)
      // Status bar is rendered inside the editor override, footer is empty
      ctx.ui.setFooter((tui: any, _theme: Theme, footerData: ReadonlyFooterDataProvider) => {
        footerDataRef = footerData;
        tuiRef = tui; // Store TUI reference for re-renders on git branch changes
        const unsub = footerData.onBranchChange(() => tui.requestRender());

        return {
          dispose: unsub,
          invalidate() {},
          render(): string[] {
            return [];
          },
        };
      });

    });
  }

  function setupWelcomeHeader(ctx: any) {
    const modelName = ctx.model?.name || ctx.model?.id || "No model";
    const providerName = ctx.model?.provider || "Unknown";
    const loadedCounts = discoverLoadedCounts();
    const recentSessions = getRecentSessions(3);
    
    const header = new WelcomeHeader(modelName, providerName, recentSessions, loadedCounts);
    welcomeHeaderActive = true; // Will be cleared on first user input
    
    ctx.ui.setHeader((_tui: any, _theme: any) => {
      return {
        render(width: number): string[] {
          return header.render(width);
        },
        invalidate() {
          header.invalidate();
        },
      };
    });
  }

  function setupWelcomeOverlay(ctx: any) {
    const modelName = ctx.model?.name || ctx.model?.id || "No model";
    const providerName = ctx.model?.provider || "Unknown";
    const loadedCounts = discoverLoadedCounts();
    const recentSessions = getRecentSessions(3);
    
    // Small delay to let pi-mono finish initialization
    setTimeout(() => {
      // Skip overlay if:
      // 1. Dismissal was explicitly requested (agent_start/user_message fired)
      // 2. Agent is already streaming
      // 3. Session already has assistant messages (agent already responded)
      if (welcomeOverlayShouldDismiss || isStreaming) {
        welcomeOverlayShouldDismiss = false;
        return;
      }
      
      // Check if session already has activity (handles p "command" case)
      const sessionEvents = ctx.sessionManager?.getBranch?.() ?? [];
      const hasActivity = sessionEvents.some((e: any) => 
        (e.type === "message" && e.message?.role === "assistant") ||
        e.type === "tool_call" ||
        e.type === "tool_result"
      );
      if (hasActivity) {
        return;
      }
      
      ctx.ui.custom(
        (tui: any, _theme: any, _keybindings: any, done: (result: void) => void) => {
          const welcome = new WelcomeComponent(
            modelName,
            providerName,
            recentSessions,
            loadedCounts,
          );
          
          let countdown = 30;
          let dismissed = false;
          
          const dismiss = () => {
            if (dismissed) return;
            dismissed = true;
            clearInterval(interval);
            dismissWelcomeOverlay = null;
            done();
          };
          
          // Store dismiss callback so user_message/keypress can trigger it
          dismissWelcomeOverlay = dismiss;
          
          // Double-check: dismissal might have been requested between the outer check
          // and this callback running
          if (welcomeOverlayShouldDismiss) {
            welcomeOverlayShouldDismiss = false;
            dismiss();
          }
          
          const interval = setInterval(() => {
            if (dismissed) return;
            countdown--;
            welcome.setCountdown(countdown);
            tui.requestRender();
            if (countdown <= 0) dismiss();
          }, 1000);
          
          return {
            focused: false,
            invalidate: () => welcome.invalidate(),
            render: (width: number) => welcome.render(width),
            handleInput: (_data: string) => dismiss(),
            dispose: () => {
              dismissed = true;
              clearInterval(interval);
            },
          };
        },
        {
          overlay: true,
          overlayOptions: () => ({
            verticalAlign: "center",
            horizontalAlign: "center",
          }),
        },
      ).catch(() => {});
    }, 100);
  }
}
