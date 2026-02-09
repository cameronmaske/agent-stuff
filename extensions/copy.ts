import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { DynamicBorder } from "@mariozechner/pi-coding-agent";
import { Container, SelectList, type SelectItem, Text } from "@mariozechner/pi-tui";

type Snippet = {
  id: number;
  lang: string;
  code: string;
  preview: string;
  messageId: string;
};

type CopyCodeSettings = {
  hintsEnabled: boolean;
};

const CODE_BLOCK_RE = /```([^\r\n]*)\r?\n([\s\S]*?)```/g;
const HINT_WIDGET_ID = "copy-code-hint";
const SETTINGS_ENTRY_TYPE = "copy-code-settings";
const DEFAULT_HINTS_ENABLED = false;
const PREVIEW_MAX_LINES = 12;
const PREVIEW_MAX_LINE_LENGTH = 160;
const MAX_HINT_SNIPPETS = 8;

export default function (pi: ExtensionAPI) {
  let lastSeenEntryId: string | null = null;
  let hintsEnabled = DEFAULT_HINTS_ENABLED;

  const restoreSettings = (ctx: ExtensionContext) => {
    hintsEnabled = DEFAULT_HINTS_ENABLED;

    const branchEntries = ctx.sessionManager.getBranch();
    let savedHintsEnabled: boolean | undefined;

    for (const entry of branchEntries) {
      if (entry.type === "custom" && entry.customType === SETTINGS_ENTRY_TYPE) {
        const data = entry.data as CopyCodeSettings | undefined;
        if (typeof data?.hintsEnabled === "boolean") {
          savedHintsEnabled = data.hintsEnabled;
        }
      }
    }

    if (typeof savedHintsEnabled === "boolean") {
      hintsEnabled = savedHintsEnabled;
    }
  };

  const updateHintWidget = (ctx: ExtensionContext, messageIds: Set<string>) => {
    if (!ctx.hasUI) return;
    const hints = buildHintLines(ctx, messageIds);
    if (hints.length > 0) {
      ctx.ui.setWidget(HINT_WIDGET_ID, hints, { placement: "belowEditor" });
    } else {
      ctx.ui.setWidget(HINT_WIDGET_ID, undefined);
    }
  };

  const setHintsEnabled = (enabled: boolean, ctx: ExtensionContext) => {
    hintsEnabled = enabled;
    pi.appendEntry<CopyCodeSettings>(SETTINGS_ENTRY_TYPE, { hintsEnabled: enabled });
    if (!ctx.hasUI) return;
    if (enabled) {
      updateHintWidget(ctx, collectAssistantEntryIds(ctx));
    } else {
      ctx.ui.setWidget(HINT_WIDGET_ID, undefined);
    }
    ctx.ui.notify(`Copy hints ${enabled ? "enabled" : "disabled"}.`, "info");
  };

  const handleHintsCommand = async (args: string, ctx: ExtensionContext) => {
    const normalized = (args || "").trim().toLowerCase();

    if (!normalized || normalized === "toggle") {
      setHintsEnabled(!hintsEnabled, ctx);
      return;
    }

    if (["on", "enable", "enabled"].includes(normalized)) {
      setHintsEnabled(true, ctx);
      return;
    }

    if (["off", "disable", "disabled"].includes(normalized)) {
      setHintsEnabled(false, ctx);
      return;
    }

    if (normalized === "status") {
      if (ctx.hasUI) {
        ctx.ui.notify(`Copy hints are ${hintsEnabled ? "enabled" : "disabled"}.`, "info");
      }
      return;
    }

    if (ctx.hasUI) {
      ctx.ui.notify("Usage: /copy hints [on|off|toggle|status]", "warning");
    }
  };

  const commandHandler = async (args: string, ctx: ExtensionContext) => {
    const trimmedArgs = (args || "").trim();

    if (startsWithHintsSubcommand(trimmedArgs)) {
      await handleHintsCommand(getSubcommandArgs(trimmedArgs), ctx);
      return;
    }

    const snippets = collectSnippets(ctx);
    if (snippets.length === 0) {
      if (ctx.hasUI) ctx.ui.notify("No code blocks found in this session.", "warning");
      return;
    }

    if (!trimmedArgs || isPickerSubcommand(trimmedArgs)) {
      if (!ctx.hasUI) {
        await copySnippet(snippets[snippets.length - 1]!, pi, ctx);
        return;
      }

      const selected = await showSnippetPicker(snippets, ctx);
      if (!selected) return;

      const snippet = snippets.find((s) => s.id === selected);
      if (!snippet) {
        ctx.ui.notify("Snippet not found.", "error");
        return;
      }

      await copySnippet(snippet, pi, ctx);
      return;
    }

    const target = resolveSnippetArg(trimmedArgs, snippets);
    if (!target) {
      if (ctx.hasUI) {
        ctx.ui.notify("No snippet matches. Try /copy <id>, /copy last, or /copy menu.", "warning");
      }
      return;
    }

    await copySnippet(target, pi, ctx);
  };

  // /copy with arguments is handled via input interception because bare /copy
  // is a built-in command in pi.
  pi.on("input", async (event, ctx) => {
    const text = event.text.trim();
    if (!text.startsWith("/copy ")) return;

    const args = text.slice("/copy".length).trim();
    if (!args) return;

    await commandHandler(args, ctx);
    return { action: "handled" as const };
  });

  // Backward-compatible alias
  pi.registerCommand("copy-code", {
    description: "Alias for /copy <args>",
    handler: commandHandler,
  });

  pi.registerShortcut("ctrl+shift+y", {
    description: "Copy code snippet from conversation",
    handler: async (ctx) => {
      await commandHandler("menu", ctx);
    },
  });

  // Backward-compatible alias
  pi.registerCommand("copy-code-hints", {
    description: "Alias for /copy hints",
    handler: async (args, ctx) => {
      await handleHintsCommand(args, ctx);
    },
  });

  pi.registerShortcut("ctrl+shift+h", {
    description: "Toggle copy hint widget",
    handler: async (ctx) => {
      setHintsEnabled(!hintsEnabled, ctx);
    },
  });

  pi.registerShortcut("ctrl+alt+h", {
    description: "Toggle copy hint widget (backup)",
    handler: async (ctx) => {
      setHintsEnabled(!hintsEnabled, ctx);
    },
  });

  const syncLastSeen = (ctx: ExtensionContext) => {
    lastSeenEntryId = ctx.sessionManager.getLeafId() ?? null;
  };

  pi.on("session_start", (_event, ctx) => {
    restoreSettings(ctx);
    syncLastSeen(ctx);
    if (ctx.hasUI && !hintsEnabled) ctx.ui.setWidget(HINT_WIDGET_ID, undefined);
  });

  pi.on("session_switch", (_event, ctx) => {
    restoreSettings(ctx);
    syncLastSeen(ctx);
    if (ctx.hasUI) ctx.ui.setWidget(HINT_WIDGET_ID, undefined);
  });

  pi.on("session_tree", (_event, ctx) => {
    restoreSettings(ctx);
    syncLastSeen(ctx);
    if (ctx.hasUI) ctx.ui.setWidget(HINT_WIDGET_ID, undefined);
  });

  pi.on("session_fork", (_event, ctx) => {
    restoreSettings(ctx);
    syncLastSeen(ctx);
    if (ctx.hasUI) ctx.ui.setWidget(HINT_WIDGET_ID, undefined);
  });

  pi.on("agent_end", (_event, ctx) => {
    if (!ctx.hasUI) {
      syncLastSeen(ctx);
      return;
    }

    if (!hintsEnabled) {
      ctx.ui.setWidget(HINT_WIDGET_ID, undefined);
      syncLastSeen(ctx);
      return;
    }

    const newAssistantEntryIds = collectNewAssistantEntryIds(ctx, lastSeenEntryId);
    updateHintWidget(ctx, newAssistantEntryIds);

    syncLastSeen(ctx);
  });
}

function collectSnippets(ctx: ExtensionContext): Snippet[] {
  const entries = ctx.sessionManager.getBranch();
  const snippets: Snippet[] = [];
  let id = 1;

  for (const entry of entries) {
    if (entry.type !== "message") continue;
    const message = entry.message;
    if (message.role !== "assistant") continue;

    const text = extractText(message.content);
    if (!text) continue;

    const blocks = extractCodeBlocks(text);
    for (const block of blocks) {
      snippets.push({
        id: id++,
        lang: block.lang || "plain",
        code: block.code,
        preview: makePreview(block.code),
        messageId: entry.id,
      });
    }
  }

  return snippets;
}

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => block && (block as { type?: string }).type === "text")
    .map((block) => (block as { text?: string }).text || "")
    .join("");
}

function extractCodeBlocks(text: string): Array<{ lang: string; code: string }> {
  const blocks: Array<{ lang: string; code: string }> = [];
  CODE_BLOCK_RE.lastIndex = 0;
  let match = CODE_BLOCK_RE.exec(text);
  while (match) {
    const lang = (match[1] || "").trim();
    const code = match[2] ?? "";
    blocks.push({ lang, code });
    match = CODE_BLOCK_RE.exec(text);
  }
  return blocks;
}

function makePreview(code: string): string {
  const firstLine = code.split(/\r?\n/).find((line) => line.trim().length > 0) ?? "";
  const trimmed = firstLine.trim();
  if (trimmed.length <= 80) return trimmed;
  return `${trimmed.slice(0, 77)}...`;
}

function resolveSnippetArg(arg: string, snippets: Snippet[]): Snippet | undefined {
  if (arg === "last") return snippets[snippets.length - 1];
  const num = Number(arg);
  if (!Number.isNaN(num)) {
    return snippets.find((s) => s.id === num);
  }
  return undefined;
}

function orderSnippetsNewestFirst(snippets: Snippet[]): Snippet[] {
  return [...snippets].sort((a, b) => b.id - a.id);
}

function startsWithHintsSubcommand(args: string): boolean {
  const token = firstToken(args);
  return token === "hints" || token === "hint";
}

function isPickerSubcommand(args: string): boolean {
  const token = firstToken(args);
  return token === "menu" || token === "pick" || token === "list" || token === "snippets";
}

function firstToken(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  const spaceIndex = trimmed.indexOf(" ");
  const token = spaceIndex === -1 ? trimmed : trimmed.slice(0, spaceIndex);
  return token.toLowerCase();
}

function getSubcommandArgs(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  const spaceIndex = trimmed.indexOf(" ");
  return spaceIndex === -1 ? "" : trimmed.slice(spaceIndex + 1).trim();
}

function formatSnippetPreview(code: string): string {
  const lines = code.replace(/\r\n/g, "\n").split("\n");
  if (lines.length === 1 && lines[0] === "") return "(empty snippet)";

  const clippedLines = lines.slice(0, PREVIEW_MAX_LINES).map((line) => {
    if (line.length <= PREVIEW_MAX_LINE_LENGTH) return line;
    return `${line.slice(0, PREVIEW_MAX_LINE_LENGTH - 1)}…`;
  });

  if (lines.length > PREVIEW_MAX_LINES) {
    clippedLines.push(`… (${lines.length - PREVIEW_MAX_LINES} more lines)`);
  }

  return clippedLines.join("\n");
}

async function showSnippetPicker(snippets: Snippet[], ctx: ExtensionContext): Promise<number | null> {
  const orderedSnippets = orderSnippetsNewestFirst(snippets);
  const items: SelectItem[] = orderedSnippets.map((snippet) => ({
    value: snippet.id.toString(),
    label: `#${snippet.id} ${snippet.lang}`,
    description: snippet.preview || "(empty)",
  }));

  const snippetById = new Map(orderedSnippets.map((snippet) => [snippet.id.toString(), snippet]));

  const result = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
    const container = new Container();
    container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
    container.addChild(new Text(theme.fg("accent", theme.bold("Copy code snippet")), 1, 0));

    const selectList = new SelectList(items, Math.min(items.length, 12), {
      selectedPrefix: (t) => theme.fg("accent", t),
      selectedText: (t) => theme.fg("accent", t),
      description: (t) => theme.fg("muted", t),
      scrollInfo: (t) => theme.fg("dim", t),
      noMatch: (t) => theme.fg("warning", t),
    });

    const previewHeader = new Text(theme.fg("accent", theme.bold("Preview")), 1, 0);
    const previewBody = new Text("", 1, 0);

    const updatePreview = (item: SelectItem | null) => {
      if (!item) {
        previewBody.setText(theme.fg("dim", "(no snippet selected)"));
        return;
      }

      const snippet = snippetById.get(item.value);
      if (!snippet) {
        previewBody.setText(theme.fg("dim", "(snippet not found)"));
        return;
      }

      previewBody.setText(theme.fg("dim", formatSnippetPreview(snippet.code)));
    };

    selectList.onSelect = (item) => done(item.value);
    selectList.onCancel = () => done(null);
    selectList.onSelectionChange = (item) => {
      updatePreview(item);
      tui.requestRender();
    };

    container.addChild(selectList);
    container.addChild(new DynamicBorder((s: string) => theme.fg("dim", s)));
    container.addChild(previewHeader);
    container.addChild(previewBody);
    container.addChild(
      new Text(theme.fg("dim", "↑↓ navigate • enter copy • esc cancel • use /copy menu (bare /copy is built-in)"), 1, 0)
    );
    container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

    updatePreview(selectList.getSelectedItem());

    return {
      render: (w) => container.render(w),
      invalidate: () => container.invalidate(),
      handleInput: (data) => {
        selectList.handleInput?.(data);
        tui.requestRender();
      },
    };
  });

  if (!result) return null;
  const parsed = Number(result);
  if (Number.isNaN(parsed)) return null;
  return parsed;
}

async function copySnippet(snippet: Snippet, pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
  const ok = await copyToClipboard(snippet.code, pi);
  if (!ctx.hasUI) return;
  if (ok) {
    ctx.ui.notify(`Copied snippet #${snippet.id} (${snippet.lang})`, "info");
  } else {
    ctx.ui.notify("Clipboard copy failed. No supported clipboard command found.", "error");
  }
}

async function copyToClipboard(text: string, pi: ExtensionAPI): Promise<boolean> {
  const base64 = Buffer.from(text, "utf8").toString("base64");
  const commands = [
    `printf '%s' '${base64}' | base64 -d | clip.exe`,
    `printf '%s' '${base64}' | base64 -d | /mnt/c/Windows/System32/clip.exe`,
    `printf '%s' '${base64}' | base64 -d | wl-copy`,
    `printf '%s' '${base64}' | base64 -d | pbcopy`,
    `printf '%s' '${base64}' | base64 -d | xclip -selection clipboard`,
  ];

  for (const cmd of commands) {
    try {
      const result = await pi.exec("bash", ["-lc", cmd]);
      if (result.code === 0) return true;
    } catch {
      // Try next command
    }
  }

  return false;
}

function collectAssistantEntryIds(ctx: ExtensionContext): Set<string> {
  const entries = ctx.sessionManager.getBranch();
  const ids = new Set<string>();

  for (const entry of entries) {
    if (entry.type !== "message") continue;
    if (entry.message.role !== "assistant") continue;
    ids.add(entry.id);
  }

  return ids;
}

function collectNewAssistantEntryIds(
  ctx: ExtensionContext,
  lastSeenEntryId: string | null
): Set<string> {
  const entries = ctx.sessionManager.getBranch();
  const ids = new Set<string>();

  const startIndex = lastSeenEntryId
    ? entries.findIndex((entry) => entry.id === lastSeenEntryId)
    : -1;

  const candidates = startIndex >= 0 ? entries.slice(startIndex + 1) : entries;

  for (const entry of candidates) {
    if (entry.type !== "message") continue;
    if (entry.message.role !== "assistant") continue;
    ids.add(entry.id);
  }

  return ids;
}

function buildHintLines(ctx: ExtensionContext, messageIds: Set<string>): string[] {
  if (messageIds.size === 0) return [];

  const snippets = orderSnippetsNewestFirst(
    collectSnippets(ctx).filter((snippet) => messageIds.has(snippet.messageId))
  );

  if (snippets.length === 0) return [];

  const lines = ["Code snippets detected:"];
  for (const snippet of snippets.slice(0, MAX_HINT_SNIPPETS)) {
    lines.push(`  #${snippet.id} (${snippet.lang}) → /copy ${snippet.id}`);
  }

  if (snippets.length > MAX_HINT_SNIPPETS) {
    lines.push(`  … and ${snippets.length - MAX_HINT_SNIPPETS} more (use /copy menu)`);
  }

  lines.push("  Toggle hints: /copy hints off");
  return lines;
}
