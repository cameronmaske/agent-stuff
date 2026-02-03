import type { ColorScheme, PresetDef, StatusLinePreset } from "./types.js";
import { getDefaultColors } from "./theme.js";

// Get base colors from theme.ts (single source of truth)
const DEFAULT_COLORS: ColorScheme = getDefaultColors();

// Minimal - more muted, less colorful
const MINIMAL_COLORS: ColorScheme = {
  ...DEFAULT_COLORS,
  pi: "dim",
  model: "text",
  path: "text",
  git: "dim",
  gitClean: "dim",
};

// Nerd - vibrant colors
const NERD_COLORS: ColorScheme = {
  ...DEFAULT_COLORS,
  pi: "accent",
  model: "accent",
  path: "success",
  tokens: "primary",
  cost: "warning",
};

export const PRESETS: Record<StatusLinePreset, PresetDef> = {
  default: {
    leftSegments: ["path", "git", "context_pct"],
    rightSegments: ["model", "thinking", "sub_usage"],
    secondarySegments: ["extension_statuses"],
    separator: "dot",
    colors: DEFAULT_COLORS,
    segmentOptions: {
      model: { showThinkingLevel: false },
      path: { mode: "basename" },
      git: { showBranch: true, showStaged: true, showUnstaged: true, showUntracked: true },
    },
  },

  minimal: {
    leftSegments: ["path", "git", "context_pct"],
    rightSegments: ["sub_usage"],
    separator: "dot",
    colors: MINIMAL_COLORS,
    segmentOptions: {
      path: { mode: "basename" },
      git: { showBranch: true, showStaged: false, showUnstaged: false, showUntracked: false },
    },
  },

  compact: {
    leftSegments: ["path", "git"],
    rightSegments: ["model", "thinking", "sub_usage", "context_pct"],
    separator: "dot",
    colors: DEFAULT_COLORS,
    segmentOptions: {
      model: { showThinkingLevel: false },
      path: { mode: "basename" },
      git: { showBranch: true, showStaged: true, showUnstaged: true, showUntracked: false },
    },
  },

  full: {
    leftSegments: ["hostname", "model", "thinking", "path", "git", "subagents"],
    rightSegments: ["token_in", "token_out", "cache_read", "sub_usage", "context_pct", "time_spent", "time", "extension_statuses"],
    separator: "dot",
    colors: DEFAULT_COLORS,
    segmentOptions: {
      model: { showThinkingLevel: false },
      path: { mode: "abbreviated", maxLength: 50 },
      git: { showBranch: true, showStaged: true, showUnstaged: true, showUntracked: true },
      time: { format: "24h", showSeconds: false },
    },
  },

  nerd: {
    leftSegments: ["hostname", "model", "thinking", "path", "git", "session", "subagents"],
    rightSegments: ["token_in", "token_out", "cache_read", "cache_write", "sub_usage", "context_pct", "context_total", "time_spent", "time", "extension_statuses"],
    separator: "dot",
    colors: NERD_COLORS,
    segmentOptions: {
      model: { showThinkingLevel: false },
      path: { mode: "abbreviated", maxLength: 60 },
      git: { showBranch: true, showStaged: true, showUnstaged: true, showUntracked: true },
      time: { format: "24h", showSeconds: true },
    },
  },

  ascii: {
    leftSegments: ["path", "git"],
    rightSegments: ["model", "thinking", "sub_usage", "context_pct"],
    separator: "dot",
    colors: MINIMAL_COLORS,
    segmentOptions: {
      model: { showThinkingLevel: false },
      path: { mode: "abbreviated", maxLength: 40 },
      git: { showBranch: true, showStaged: true, showUnstaged: true, showUntracked: true },
    },
  },

  custom: {
    leftSegments: ["path", "git", "context_pct"],
    rightSegments: ["model", "thinking", "sub_usage"],
    separator: "dot",
    colors: DEFAULT_COLORS,
    segmentOptions: {},
  },
};

export function getPreset(name: StatusLinePreset): PresetDef {
  return PRESETS[name] ?? PRESETS.default;
}
