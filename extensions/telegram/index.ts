import type {
	AgentMessage,
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	TurnEndEvent,
} from "@mariozechner/pi-coding-agent";
import { spawn } from "node:child_process";
import * as fsp from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

type TopicIconState = "thinking" | "green" | "yellow" | "red";
type VoiceSetupIssue = "command" | "binary" | "model" | "ffmpeg";

type DaemonToClientMessage =
	| {
			type: "registered";
			windowId: string;
			windowNo: number;
			ownerUserId: number | null;
			forumChatId: number | null;
			boundThreadId: number | null;
			boundTopicTitle: string | null;
	  }
	| { type: "pin"; code: string; expiresAt: number }
	| {
			type: "topic_created";
			windowId: string;
			chatId: number;
			messageThreadId: number;
			title: string;
	  }
	| { type: "pong" }
	| { type: "ok" }
	| { type: "error"; error: string }
	| { type: "inject"; mode: "followUp" | "steer"; text: string }
	| { type: "abort" }
	| { type: "reload" }
	| { type: "session_new" }
	| { type: "voice_setup_required"; issue: VoiceSetupIssue; detail: string };

type ClientToDaemonMessage =
	| {
			type: "register";
			windowId: string;
			cwd: string;
			sessionName?: string;
			busy: boolean;
			modelLabel?: string;
			thinkingLevel?: string;
	  }
	| {
			type: "meta";
			cwd: string;
			sessionName?: string;
			busy: boolean;
			modelLabel?: string;
			thinkingLevel?: string;
	  }
	| { type: "request_pin" }
	| { type: "create_topic"; title: string }
	| { type: "bind_topic"; chatId: number; messageThreadId: number; title?: string }
	| { type: "unpair" }
	| { type: "turn_progress"; text: string }
	| { type: "turn_end"; text?: string }
	| { type: "topic_icon"; state: TopicIconState; contextPercent?: number }
	| { type: "shutdown" }
	| { type: "ping" };

type Config = {
	botToken?: string;
	ownerUserId?: number;
	ownerDmChatId?: number;
	forumChatId?: number;
	pairedChatId?: number; // legacy
	voiceTranscribeCommand?: string;
	voiceTranscribeTimeoutSec?: number;
	whisperModelPath?: string;
};

type TopicBinding = {
	chatId: number;
	messageThreadId: number;
	title?: string;
};

const TOPIC_BINDING_ENTRY = "telegram-topic-binding";

const WHISPER_MODEL_ALIASES = [
	"tiny",
	"tiny.en",
	"base",
	"base.en",
	"small",
	"small.en",
	"medium",
	"medium.en",
	"large-v1",
	"large-v2",
	"large-v3",
	"large-v3-turbo",
] as const;

const TELEGRAM_RECONNECT_TOTAL_MS = 3 * 60 * 1000;
const TELEGRAM_RECONNECT_INITIAL_DELAY_MS = 1500;
const TELEGRAM_RECONNECT_MAX_DELAY_MS = 5000;

function getAgentDir() {
	if (process.env.PI_CODING_AGENT_DIR && process.env.PI_CODING_AGENT_DIR.trim()) {
		return path.resolve(process.env.PI_CODING_AGENT_DIR);
	}
	return path.join(os.homedir(), ".pi", "agent");
}

const AGENT_DIR = getAgentDir();
const EXTENSION_DIR = path.dirname(fileURLToPath(import.meta.url));
const RUN_DIR = path.join(AGENT_DIR, "run");
const SOCKET_PATH = path.join(RUN_DIR, "telegram.sock");
const CONFIG_PATH = path.join(EXTENSION_DIR, "config.json");
const LEGACY_CONFIG_PATH = path.join(AGENT_DIR, "telegram", "config.json");
const WHISPER_DIR = path.join(EXTENSION_DIR, "whisper.cpp");
const WHISPER_WRAPPER_PATH = path.join(EXTENSION_DIR, "transcribe-voice-whispercpp.sh");
const WHISPER_CPU_BIN = path.join(WHISPER_DIR, "build", "bin", "whisper-cli");
const WHISPER_CUDA_BIN = path.join(WHISPER_DIR, "build-cuda", "bin", "whisper-cli");
const DEFAULT_WHISPER_MODEL_ALIAS = "large-v3-turbo" as const;

function sleep(ms: number) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseArgs(args: string | undefined): string[] {
	if (!args) return [];
	const trimmed = args.trim();
	if (!trimmed) return [];
	return trimmed.split(/\s+/g);
}

function splitSubcommand(args: string): { subcommand: string; rest: string } {
	const trimmed = args.trim();
	if (!trimmed) return { subcommand: "topic", rest: "" };
	const [subcommand, ...restParts] = parseArgs(trimmed);
	return { subcommand: subcommand.toLowerCase(), rest: restParts.join(" ").trim() };
}

function expandHomePath(inputPath: string): string {
	if (inputPath === "~") return os.homedir();
	if (inputPath.startsWith("~/")) {
		return path.join(os.homedir(), inputPath.slice(2));
	}
	return inputPath;
}

function resolveWhisperModelPath(specifier: string): { path: string; alias?: string } {
	const normalized = specifier.trim();
	if (!normalized) {
		throw new Error("Missing whisper model specifier");
	}

	if ((WHISPER_MODEL_ALIASES as readonly string[]).includes(normalized)) {
		return {
			path: path.join(EXTENSION_DIR, "whisper.cpp", "models", `ggml-${normalized}.bin`),
			alias: normalized,
		};
	}

	const expanded = expandHomePath(normalized);
	const resolved = path.isAbsolute(expanded) ? expanded : path.resolve(process.cwd(), expanded);
	return { path: resolved };
}

async function pathExists(targetPath: string): Promise<boolean> {
	try {
		await fsp.access(targetPath);
		return true;
	} catch {
		return false;
	}
}

function shellQuote(value: string): string {
	return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}

async function runShellCommand(
	command: string,
	cwd: string,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
	return await new Promise((resolve) => {
		const child = spawn("bash", ["-lc", command], {
			cwd,
			env: { ...process.env },
			stdio: ["ignore", "pipe", "pipe"],
		});

		let stdout = "";
		let stderr = "";

		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");

		child.stdout.on("data", (chunk: string) => {
			stdout += chunk;
		});
		child.stderr.on("data", (chunk: string) => {
			stderr += chunk;
		});

		child.on("close", (code) => {
			resolve({ code, stdout, stderr });
		});

		child.on("error", (error) => {
			resolve({ code: null, stdout, stderr: `${stderr}\n${String(error?.message ?? error)}` });
		});
	});
}

function summarizeShellFailure(result: { code: number | null; stdout: string; stderr: string }): string {
	const merged = `${result.stderr}\n${result.stdout}`
		.split(/\r?\n/g)
		.map((line) => line.trim())
		.filter((line) => line.length > 0);
	if (merged.length === 0) {
		return `exit code ${result.code ?? "unknown"}`;
	}
	return shortText(merged.slice(-3).join(" | "), 260);
}

async function commandExists(commandName: string): Promise<boolean> {
	const result = await runShellCommand(`command -v ${shellQuote(commandName)} >/dev/null 2>&1`, EXTENSION_DIR);
	return result.code === 0;
}

function isWhisperModelAlias(value: string): value is (typeof WHISPER_MODEL_ALIASES)[number] {
	return (WHISPER_MODEL_ALIASES as readonly string[]).includes(value);
}

function jsonlWrite(socket: net.Socket, message: ClientToDaemonMessage) {
	socket.write(`${JSON.stringify(message)}\n`);
}

function createJsonlReader(socket: net.Socket, onMessage: (msg: DaemonToClientMessage) => void) {
	socket.setEncoding("utf8");
	let buffer = "";

	socket.on("data", (data: string) => {
		buffer += data;
		while (true) {
			const newlineIndex = buffer.indexOf("\n");
			if (newlineIndex === -1) break;

			const line = buffer.slice(0, newlineIndex).trim();
			buffer = buffer.slice(newlineIndex + 1);

			if (!line) continue;

			try {
				const parsed = JSON.parse(line);
				if (parsed && typeof parsed.type === "string") {
					onMessage(parsed as DaemonToClientMessage);
				}
			} catch {
				// Ignore malformed daemon line.
			}
		}
	});
}

async function readConfigFile(configPath: string): Promise<Config | null> {
	try {
		const raw = await fsp.readFile(configPath, "utf8");
		return JSON.parse(raw) as Config;
	} catch {
		return null;
	}
}

async function loadConfig(): Promise<Config> {
	const current = await readConfigFile(CONFIG_PATH);
	if (current) return current;

	const legacy = await readConfigFile(LEGACY_CONFIG_PATH);
	if (legacy) {
		await saveConfig(legacy);
		return legacy;
	}

	return {};
}

async function saveConfig(config: Config): Promise<void> {
	await fsp.mkdir(path.dirname(CONFIG_PATH), { recursive: true, mode: 0o700 });
	const tempPath = `${CONFIG_PATH}.tmp`;
	await fsp.writeFile(tempPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
	await fsp.rename(tempPath, CONFIG_PATH);
}

function extractAssistantText(message: AgentMessage): string {
	if (message.role !== "assistant") return "";
	if (!Array.isArray(message.content)) return "";

	return message.content
		.map((part) => {
			if (part.type === "text" && typeof part.text === "string") {
				return part.text;
			}
			return "";
		})
		.filter((text) => text.length > 0)
		.join("\n")
		.trim();
}

function clampPercent(value: number): number {
	if (!Number.isFinite(value)) return 0;
	return Math.max(0, Math.min(100, value));
}

function getContextPercent(ctx: ExtensionContext | ExtensionCommandContext | null): number | null {
	if (!ctx) return null;
	const usage = ctx.getContextUsage();
	if (!usage || typeof usage.percent !== "number") return null;
	return clampPercent(usage.percent);
}

function stateFromContextPercent(percent: number | null): Exclude<TopicIconState, "thinking"> {
	if (typeof percent !== "number") return "green";
	if (percent >= 80) return "red";
	if (percent >= 60) return "yellow";
	return "green";
}

function getModelLabel(ctx: ExtensionContext | ExtensionCommandContext | null): string | undefined {
	const model = ctx?.model;
	if (!model) return undefined;

	if (typeof model.name === "string" && model.name.trim()) {
		return model.name.trim();
	}
	if (typeof model.id === "string" && model.id.trim()) {
		return model.id.trim();
	}
	return undefined;
}

function getThinkingLevelLabel(pi: ExtensionAPI): string | undefined {
	try {
		const level = pi.getThinkingLevel();
		if (typeof level === "string" && level.trim()) {
			return level.trim();
		}
	} catch {
		// Ignore thinking-level resolution errors.
	}
	return undefined;
}

async function canConnectSocket(): Promise<boolean> {
	return await new Promise((resolve) => {
		const socket = net.connect(SOCKET_PATH);

		const done = (ok: boolean) => {
			socket.removeAllListeners();
			try {
				socket.end();
			} catch {
				// Ignore close errors.
			}
			try {
				socket.destroy();
			} catch {
				// Ignore destroy errors.
			}
			resolve(ok);
		};

		socket.once("connect", () => done(true));
		socket.once("error", () => done(false));
	});
}

async function ensureDaemonRunning(daemonPath: string): Promise<void> {
	await fsp.mkdir(RUN_DIR, { recursive: true, mode: 0o700 });

	if (await canConnectSocket()) return;

	const deadline = Date.now() + 15_000;
	let attempts = 0;

	while (Date.now() < deadline) {
		attempts += 1;
		const child = spawn(process.execPath, [daemonPath], {
			detached: true,
			stdio: "ignore",
			env: { ...process.env },
		});
		child.unref();

		const attemptDeadline = Date.now() + 4_000;
		while (Date.now() < attemptDeadline && Date.now() < deadline) {
			if (await canConnectSocket()) return;
			await sleep(120);
		}
	}

	throw new Error(`Failed to start telegram daemon (socket unavailable after ${attempts} attempts)`);
}

async function sendEphemeral(message: ClientToDaemonMessage): Promise<void> {
	const socket = net.connect(SOCKET_PATH);

	await new Promise<void>((resolve, reject) => {
		socket.once("connect", () => resolve());
		socket.once("error", (error) => reject(error));
	});

	socket.write(`${JSON.stringify(message)}\n`);
	socket.end();
}

function shortText(text: string, max = 120): string {
	if (text.length <= max) return text;
	return `${text.slice(0, max - 1)}…`;
}

function compactWhitespace(value: string): string {
	return value.replace(/\s+/g, " ").trim();
}

function summarizePathForStatus(rawPath: string): string {
	const normalized = compactWhitespace(rawPath.replace(/^@/, "").trim());
	if (!normalized) return "file";

	const parsed = path.parse(normalized);
	const parent = parsed.dir ? path.basename(parsed.dir) : "";
	const baseName = parsed.base || parsed.name;

	if (!baseName) return shortText(normalized, 56);
	if (!parent || parent === "." || parent === "/") return shortText(baseName, 56);

	return shortText(`${parent}/${baseName}`, 56);
}

function summarizeCommandForStatus(rawCommand: string): string {
	const compact = compactWhitespace(rawCommand);
	if (!compact) return "command";
	return shortText(compact, 80);
}

function formatToolProgress(toolName: string, input: Record<string, unknown>): string {
	if (toolName === "read" && typeof input.path === "string") {
		return `Reading ${summarizePathForStatus(input.path)}…`;
	}
	if (toolName === "edit" && typeof input.path === "string") {
		return `Editing ${summarizePathForStatus(input.path)}…`;
	}
	if (toolName === "write" && typeof input.path === "string") {
		return `Writing ${summarizePathForStatus(input.path)}…`;
	}
	if (toolName === "bash" && typeof input.command === "string") {
		return `Running ${summarizeCommandForStatus(input.command)}…`;
	}
	if (toolName === "find" && typeof input.path === "string") {
		return `Scanning ${summarizePathForStatus(input.path)}…`;
	}
	if (toolName === "grep" && typeof input.pattern === "string") {
		return `Searching for “${shortText(compactWhitespace(input.pattern), 48)}”…`;
	}
	if (toolName === "web_search") {
		if (typeof input.query === "string" && input.query.trim()) {
			return `Searching the web for “${shortText(compactWhitespace(input.query), 48)}”…`;
		}
		if (Array.isArray(input.queries) && input.queries.length > 0 && typeof input.queries[0] === "string") {
			return `Searching the web for “${shortText(compactWhitespace(input.queries[0]), 48)}”…`;
		}
		return "Searching the web…";
	}
	if (toolName === "fetch_content") {
		return "Fetching content…";
	}
	if (toolName === "get_search_content") {
		return "Loading fetched content…";
	}
	if (toolName === "todo") {
		return "Updating TODO list…";
	}
	if (toolName === "plan") {
		return "Updating plan…";
	}
	if (toolName === "read") return "Reading files…";
	if (toolName === "edit") return "Editing files…";
	if (toolName === "write") return "Writing files…";
	if (toolName === "bash") return "Running command…";
	if (toolName === "grep") return "Searching files…";
	if (toolName === "find") return "Scanning files…";
	if (toolName === "ls") return "Listing files…";
	
	return `Using ${toolName}…`;
}

const TOPIC_STOP_WORDS = new Set([
	"a",
	"an",
	"and",
	"are",
	"as",
	"at",
	"be",
	"by",
	"can",
	"could",
	"do",
	"for",
	"from",
	"help",
	"how",
	"i",
	"in",
	"into",
	"is",
	"it",
	"its",
	"just",
	"let",
	"lets",
	"like",
	"make",
	"my",
	"need",
	"of",
	"on",
	"or",
	"our",
	"please",
	"set",
	"so",
	"some",
	"that",
	"the",
	"this",
	"to",
	"up",
	"use",
	"we",
	"what",
	"with",
	"you",
	"your",
]);

function messageContentToText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";

	return content
		.map((part) => {
			if (!part || typeof part !== "object") return "";
			const value = part as { type?: string; text?: string };
			if (value.type === "text" && typeof value.text === "string") {
				return value.text;
			}
			return "";
		})
		.filter((text) => text.length > 0)
		.join(" ")
		.trim();
}

function normalizeTopicWords(text: string, maxWords = 4): string {
	const cleaned = text
		.toLowerCase()
		.replace(/https?:\/\/\S+/g, " ")
		.replace(/["'`*_#~()[\]{}<>:;!?.,/\\|=+]+/g, " ")
		.replace(/\s+/g, " ")
		.trim();

	const words = cleaned
		.split(" ")
		.map((word) => word.trim())
		.filter((word) => word.length > 1)
		.filter((word) => !TOPIC_STOP_WORDS.has(word));

	const selected = words.slice(0, maxWords);
	return selected.join(" ").trim();
}

function summarizePromptForTopic(prompt: string): string {
	let text = prompt.trim();
	if (!text) return "";

	text = text.replace(/^\/?telegram\b/i, "").trim();
	text = text.replace(/^(please|can you|could you|lets|let's|i want to|help me|we need to|need to)\s+/i, "");

	const summary = normalizeTopicWords(text, 4);
	if (summary) return summary;

	const fallback = text
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, 36)
		.trim();

	return fallback;
}

function summarizePathForTopic(filePath: string): string {
	const normalized = filePath.replace(/^@/, "").trim();
	if (!normalized) return "";

	const parsed = path.parse(normalized);
	let name = parsed.name;
	if (name.toLowerCase() === "index" || name.toLowerCase() === "main") {
		name = path.basename(parsed.dir);
	}
	if (!name) {
		name = path.basename(parsed.dir);
	}

	name = name.replace(/[-_.]+/g, " ");
	return normalizeTopicWords(name, 3);
}

function deriveSessionTopicBase(
	ctx: ExtensionCommandContext,
	sessionName: string | undefined,
	cwd: string,
	customTitle: string,
): string {
	if (customTitle.trim()) {
		return customTitle.trim();
	}

	if (sessionName?.trim()) {
		return sessionName.trim();
	}

	const branch = ctx.sessionManager.getBranch();
	for (let i = branch.length - 1; i >= 0; i -= 1) {
		const entry = branch[i];
		if (entry.type !== "message") continue;

		const message = entry.message as {
			role?: string;
			content?: unknown;
		};

		if (message.role === "user") {
			const text = messageContentToText(message.content).trim();
			if (!text || text.startsWith("/")) continue;
			const summary = summarizePromptForTopic(text);
			if (summary) return summary;
		}

		if (message.role === "assistant" && Array.isArray(message.content)) {
			for (let j = message.content.length - 1; j >= 0; j -= 1) {
				const part = message.content[j] as {
					type?: string;
					name?: string;
					arguments?: Record<string, unknown>;
				};
				if (part?.type !== "toolCall") continue;
				if (!part.arguments || typeof part.arguments !== "object") continue;

				if (
					(part.name === "read" || part.name === "edit" || part.name === "write") &&
					typeof part.arguments.path === "string"
				) {
					const fromPath = summarizePathForTopic(part.arguments.path);
					if (fromPath) return fromPath;
				}
			}
		}
	}

	return path.basename(cwd) || "session";
}

function buildTopicTitle(base: string): string {
	const normalized = base.replace(/\s+/g, " ").trim();
	const title = normalized.replace(/^pi\s+/i, "").trim() || "session";
	if (title.length <= 120) return title;
	return `${title.slice(0, 119)}…`;
}

function parseTopicBinding(value: unknown): TopicBinding | null {
	if (!value || typeof value !== "object") return null;
	const data = value as { chatId?: unknown; messageThreadId?: unknown; title?: unknown };
	if (typeof data.chatId !== "number" || typeof data.messageThreadId !== "number") return null;
	return {
		chatId: data.chatId,
		messageThreadId: data.messageThreadId,
		title: typeof data.title === "string" ? data.title : undefined,
	};
}

function getLatestTopicBinding(ctx: ExtensionContext | ExtensionCommandContext): TopicBinding | null {
	const branch = ctx.sessionManager.getBranch();
	for (let i = branch.length - 1; i >= 0; i -= 1) {
		const entry = branch[i] as {
			type: string;
			customType?: string;
			data?: unknown;
		};
		if (entry.type !== "custom") continue;
		if (entry.customType !== TOPIC_BINDING_ENTRY) continue;
		const binding = parseTopicBinding(entry.data);
		if (binding) return binding;
	}
	return null;
}

export default function (pi: ExtensionAPI) {
	const daemonPath = path.join(EXTENSION_DIR, "daemon.mjs");

	const state = {
		socket: null as net.Socket | null,
		windowId: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
		windowNo: null as number | null,
		busy: false,
		lastCtx: null as ExtensionContext | null,
		lastCommandCtx: null as ExtensionCommandContext | null,
		ownerUserId: null as number | null,
		forumChatId: null as number | null,
		boundChatId: null as number | null,
		boundThreadId: null as number | null,
		boundTopicTitle: null as string | null,
		lastTopicIconState: null as TopicIconState | null,
		lastTopicContextPercent: null as number | null,
		suppressDisconnectNotice: false,
		autoReconnectEnabled: true,
		reconnectInProgress: false,
		voiceSetupPromptInFlight: false,
		lastVoiceSetupPromptAt: 0,
		voiceInstallInProgress: false,
	};

	const daemonHandlers = new Set<(msg: DaemonToClientMessage) => void>();

	function notify(
		ctx: ExtensionContext | ExtensionCommandContext | null,
		text: string,
		type: "info" | "warning" | "error" = "info",
	) {
		if (!ctx || !ctx.hasUI) return;
		ctx.ui.notify(text, type);
	}

	function updateUiStatus(ctx: ExtensionContext | ExtensionCommandContext | null) {
		if (!ctx || !ctx.hasUI) return;
		if (!state.socket || state.socket.destroyed || state.windowNo === null) {
			ctx.ui.setStatus("telegram", undefined);
			ctx.ui.setWidget("telegram", undefined);
			return;
		}

		let text = "telegram: connected";
		if (state.boundTopicTitle?.trim()) {
			const topic = state.boundTopicTitle.trim();
			const topicLabel = topic.length > 28 ? `${topic.slice(0, 27)}…` : topic;
			text += ` • ${topicLabel}`;
		}

		ctx.ui.setStatus("telegram", ctx.ui.theme.fg("dim", text));
	}

	function describeVoiceSetupIssue(issue: VoiceSetupIssue): string {
		switch (issue) {
			case "command":
				return "voiceTranscribeCommand is not configured";
			case "binary":
				return "whisper-cli binary is missing";
			case "model":
				return "whisper model file is missing";
			case "ffmpeg":
				return "ffmpeg is not installed";
			default:
				return "voice transcription setup is incomplete";
		}
	}

	function pickWhisperInstallAlias(config: Config, requestedAlias?: string): (typeof WHISPER_MODEL_ALIASES)[number] {
		const requested = requestedAlias?.trim();
		if (requested) {
			if (!isWhisperModelAlias(requested)) {
				throw new Error(
					`Unsupported model alias: ${requested}. Use one of: ${WHISPER_MODEL_ALIASES.join(", ")}`,
				);
			}
			return requested;
		}

		const configured = config.whisperModelPath?.trim();
		if (configured && isWhisperModelAlias(configured)) {
			return configured;
		}

		return DEFAULT_WHISPER_MODEL_ALIAS;
	}

	async function runWhisperInstallFlow(
		ctx: ExtensionContext | ExtensionCommandContext,
		options: { requestedAlias?: string } = {},
	): Promise<boolean> {
		if (state.voiceInstallInProgress) {
			notify(ctx, "Whisper install is already running in this session.", "warning");
			return false;
		}

		state.voiceInstallInProgress = true;
		try {
			const config = await loadConfig();
			const modelAlias = pickWhisperInstallAlias(config, options.requestedAlias);
			const modelPath = path.join(WHISPER_DIR, "models", `ggml-${modelAlias}.bin`);

			notify(ctx, "Setting up whisper.cpp for Telegram voice transcription…", "info");

			if (!(await pathExists(WHISPER_DIR))) {
				if (!(await commandExists("git"))) {
					notify(ctx, "git is required to clone whisper.cpp, but it was not found in PATH.", "error");
					return false;
				}

				notify(ctx, "whisper.cpp source missing. Cloning upstream repository…", "info");
				const clone = await runShellCommand(
					"git clone --depth 1 https://github.com/ggml-org/whisper.cpp.git whisper.cpp",
					EXTENSION_DIR,
				);
				if (clone.code !== 0) {
					notify(ctx, `Failed to clone whisper.cpp: ${summarizeShellFailure(clone)}`, "error");
					return false;
				}
			}

			const hasWhisperBin = await pathExists(WHISPER_CUDA_BIN) || await pathExists(WHISPER_CPU_BIN);
			if (!hasWhisperBin) {
				if (!(await commandExists("cmake"))) {
					notify(ctx, "cmake is required to build whisper.cpp, but it was not found in PATH.", "error");
					return false;
				}

				notify(ctx, "Building whisper.cpp (CUDA first)…", "info");
				const cudaBuild = await runShellCommand(
					"cmake -S whisper.cpp -B whisper.cpp/build-cuda -DGGML_CUDA=1 && cmake --build whisper.cpp/build-cuda -j --config Release",
					EXTENSION_DIR,
				);
				const cudaReady = cudaBuild.code === 0 && (await pathExists(WHISPER_CUDA_BIN));
				if (!cudaReady) {
					const cudaFailure = cudaBuild.code === 0
						? "build succeeded but whisper-cli was not produced in build-cuda/bin"
						: summarizeShellFailure(cudaBuild);
					notify(ctx, `CUDA build unavailable (${cudaFailure}). Falling back to CPU build…`, "warning");

					const cpuBuild = await runShellCommand(
						"cmake -S whisper.cpp -B whisper.cpp/build && cmake --build whisper.cpp/build -j --config Release",
						EXTENSION_DIR,
					);
					const cpuReady = cpuBuild.code === 0 && (await pathExists(WHISPER_CPU_BIN));
					if (!cpuReady) {
						const cpuFailure = cpuBuild.code === 0
							? "build succeeded but whisper-cli was not produced in build/bin"
							: summarizeShellFailure(cpuBuild);
						notify(
							ctx,
							`Failed to build whisper.cpp (CUDA + CPU fallback). CUDA: ${cudaFailure} | CPU: ${cpuFailure}`,
							"error",
						);
						return false;
					}
				} else {
					notify(ctx, "Built whisper.cpp with CUDA support.", "info");
				}
			}

			if (!(await pathExists(modelPath))) {
				notify(ctx, `Downloading whisper model (${modelAlias})…`, "info");
				const download = await runShellCommand(
					`bash whisper.cpp/models/download-ggml-model.sh ${shellQuote(modelAlias)}`,
					EXTENSION_DIR,
				);
				if (download.code !== 0) {
					notify(ctx, `Failed to download model ${modelAlias}: ${summarizeShellFailure(download)}`, "error");
					return false;
				}
			}

			try {
				await fsp.chmod(WHISPER_WRAPPER_PATH, 0o755);
			} catch {
				// Ignore chmod failures; script may already be executable.
			}

			const updatedConfig = await loadConfig();
			updatedConfig.voiceTranscribeCommand = `${WHISPER_WRAPPER_PATH} {input}`;
			updatedConfig.whisperModelPath = modelAlias;
			if (
				typeof updatedConfig.voiceTranscribeTimeoutSec !== "number" ||
				!Number.isFinite(updatedConfig.voiceTranscribeTimeoutSec)
			) {
				updatedConfig.voiceTranscribeTimeoutSec = 600;
			}
			await saveConfig(updatedConfig);

			notify(ctx, `Whisper setup complete (model: ${modelAlias}).`, "info");
			return true;
		} catch (error) {
			notify(ctx, `Whisper setup failed: ${String(error)}`, "error");
			return false;
		} finally {
			state.voiceInstallInProgress = false;
		}
	}

	async function handleVoiceSetupRequired(message: Extract<DaemonToClientMessage, { type: "voice_setup_required" }>) {
		const ctx = state.lastCtx;
		if (!ctx) return;

		const reason = describeVoiceSetupIssue(message.issue);
		notify(
			ctx,
			`Telegram voice memo transcription needs setup (${reason}). Run /telegram voice-install.`,
			"warning",
		);

		if (!ctx.hasUI || state.voiceSetupPromptInFlight || state.voiceInstallInProgress) {
			return;
		}

		const now = Date.now();
		if (now - state.lastVoiceSetupPromptAt < 120_000) {
			return;
		}

		state.lastVoiceSetupPromptAt = now;
		state.voiceSetupPromptInFlight = true;
		try {
			const confirmed = await ctx.ui.confirm(
				"Install whisper.cpp for Telegram voice memos?",
				[
					`Issue: ${reason}`,
					message.detail ? `Details: ${message.detail}` : "",
					"",
					"Run guided install now?",
				].filter((line) => line.length > 0).join("\n"),
			);
			if (!confirmed) return;
			await runWhisperInstallFlow(ctx);
		} finally {
			state.voiceSetupPromptInFlight = false;
		}
	}

	function disconnect(silent = false) {
		if (silent) {
			state.suppressDisconnectNotice = true;
		}
		if (state.socket && !state.socket.destroyed) {
			try {
				state.socket.end();
			} catch {
				// Ignore close errors.
			}
			try {
				state.socket.destroy();
			} catch {
				// Ignore destroy errors.
			}
		}
		state.socket = null;
		state.windowNo = null;
		updateUiStatus(state.lastCtx);
	}

	function send(message: ClientToDaemonMessage) {
		if (!state.socket || state.socket.destroyed) return;
		try {
			jsonlWrite(state.socket, message);
		} catch {
			// Ignore write failures; close handler will clean up.
		}
	}

	function updateMeta() {
		send({
			type: "meta",
			cwd: process.cwd(),
			sessionName: pi.getSessionName() ?? undefined,
			busy: state.busy,
			modelLabel: getModelLabel(state.lastCtx),
			thinkingLevel: getThinkingLevelLabel(pi),
		});
	}

	function pushTopicIconState(
		ctx: ExtensionContext | ExtensionCommandContext | null,
		options: { force?: boolean } = {},
	) {
		if (!state.socket || state.socket.destroyed) return;

		const contextPercent = getContextPercent(ctx);
		const nextState: TopicIconState = state.busy ? "thinking" : stateFromContextPercent(contextPercent);
		const normalizedPercent = typeof contextPercent === "number" ? Math.round(contextPercent * 10) / 10 : null;

		const stateChanged = nextState !== state.lastTopicIconState;
		const percentChanged = normalizedPercent !== state.lastTopicContextPercent;
		const shouldReactToPercent = nextState !== "thinking";
		if (!options.force && !stateChanged && !(shouldReactToPercent && percentChanged)) {
			return;
		}

		state.lastTopicIconState = nextState;
		state.lastTopicContextPercent = normalizedPercent;

		send({
			type: "topic_icon",
			state: nextState,
			contextPercent: typeof normalizedPercent === "number" ? normalizedPercent : undefined,
		});
	}

	async function refreshStateFromConfig() {
		const config = await loadConfig();
		state.ownerUserId = typeof config.ownerUserId === "number" ? config.ownerUserId : null;
		state.forumChatId = typeof config.forumChatId === "number" ? config.forumChatId : null;
	}

	function applyTopicBinding(binding: TopicBinding | null) {
		if (!binding) {
			state.boundChatId = null;
			state.boundThreadId = null;
			state.boundTopicTitle = null;
			return;
		}
		state.boundChatId = binding.chatId;
		state.boundThreadId = binding.messageThreadId;
		state.boundTopicTitle = binding.title ?? null;
	}

	function persistTopicBinding(binding: TopicBinding) {
		pi.appendEntry(TOPIC_BINDING_ENTRY, {
			chatId: binding.chatId,
			messageThreadId: binding.messageThreadId,
			title: binding.title,
			updatedAt: Date.now(),
		});
	}

	async function bindTopicInDaemon(binding: TopicBinding) {
		send({
			type: "bind_topic",
			chatId: binding.chatId,
			messageThreadId: binding.messageThreadId,
			title: binding.title,
		});
	}

	function getCurrentTopicBinding(): TopicBinding | null {
		if (typeof state.boundChatId === "number" && typeof state.boundThreadId === "number") {
			return {
				chatId: state.boundChatId,
				messageThreadId: state.boundThreadId,
				title: state.boundTopicTitle ?? undefined,
			};
		}

		if (state.lastCtx) {
			return getLatestTopicBinding(state.lastCtx);
		}

		return null;
	}

	function hasCommandContext(
		ctx: ExtensionContext | ExtensionCommandContext | null,
	): ctx is ExtensionCommandContext {
		if (!ctx) return false;
		return typeof (ctx as Partial<ExtensionCommandContext>).newSession === "function"
			&& typeof (ctx as Partial<ExtensionCommandContext>).waitForIdle === "function";
	}

	function getRemoteCommandContext(): ExtensionCommandContext | null {
		if (hasCommandContext(state.lastCommandCtx)) {
			return state.lastCommandCtx;
		}
		if (hasCommandContext(state.lastCtx)) {
			return state.lastCtx;
		}
		return null;
	}

	async function startNewSessionFromTelegramCommand(): Promise<void> {
		const commandCtx = getRemoteCommandContext();
		if (!commandCtx) {
			throw new Error("No command context available. Run /telegram in your terminal once, then retry /new in Telegram.");
		}

		const binding = getCurrentTopicBinding() ?? getLatestTopicBinding(commandCtx);
		if (!commandCtx.isIdle()) {
			commandCtx.abort();
			await commandCtx.waitForIdle();
		}

		const result = await commandCtx.newSession({
			setup: binding
				? async (sessionManager) => {
					sessionManager.appendCustomEntry(TOPIC_BINDING_ENTRY, {
						chatId: binding.chatId,
						messageThreadId: binding.messageThreadId,
						title: binding.title,
						updatedAt: Date.now(),
					});
				}
				: undefined,
		});

		if (result.cancelled) {
			throw new Error("New session was cancelled by an extension hook.");
		}

		state.lastCtx = commandCtx;
		state.lastCommandCtx = commandCtx;
		state.busy = false;

		if (binding) {
			applyTopicBinding(binding);
			await bindTopicInDaemon(binding);
		}

		if (state.socket && !state.socket.destroyed) {
			updateMeta();
			pushTopicIconState(commandCtx, { force: true });
		}
		updateUiStatus(commandCtx);
	}

	async function attemptAutoReconnect(reason: "close" | "error") {
		if (state.reconnectInProgress || !state.autoReconnectEnabled) return;

		state.reconnectInProgress = true;
		const startedAt = Date.now();
		let delayMs = TELEGRAM_RECONNECT_INITIAL_DELAY_MS;
		let announcedReconnect = false;

		const initialBinding = getCurrentTopicBinding();

		while (Date.now() - startedAt < TELEGRAM_RECONNECT_TOTAL_MS) {
			if (!state.autoReconnectEnabled) {
				state.reconnectInProgress = false;
				return;
			}

			try {
				await connectPersistent(state.lastCtx ?? undefined);
				updateMeta();

				const binding = initialBinding ?? getCurrentTopicBinding();
				if (binding) {
					applyTopicBinding(binding);
					persistTopicBinding(binding);
					await bindTopicInDaemon(binding);
				}
				pushTopicIconState(state.lastCtx, { force: true });

				updateUiStatus(state.lastCtx);
				if (announcedReconnect) {
					notify(state.lastCtx, "Telegram daemon reconnected.", "info");
				}
				state.reconnectInProgress = false;
				return;
			} catch {
				if (!announcedReconnect) {
					notify(
						state.lastCtx,
						reason === "error"
							? "Telegram daemon connection lost. Reconnecting…"
							: "Telegram daemon disconnected. Reconnecting…",
						"warning",
					);
					announcedReconnect = true;
				}
				await sleep(delayMs);
				delayMs = Math.min(TELEGRAM_RECONNECT_MAX_DELAY_MS, Math.floor(delayMs * 1.5));
			}
		}

		if (announcedReconnect && state.autoReconnectEnabled) {
			notify(
				state.lastCtx,
				"Telegram reconnect timed out after 3 minutes. Run /telegram to reconnect.",
				"warning",
			);
		}
		state.reconnectInProgress = false;
	}

	async function restoreTopicBinding(ctx: ExtensionContext | ExtensionCommandContext) {
		const binding = getLatestTopicBinding(ctx);
		applyTopicBinding(binding);
		updateUiStatus(ctx);

		if (!binding) return;

		const config = await loadConfig();
		if (!config.botToken) return;

		try {
			await connectPersistent(ctx);
			await bindTopicInDaemon(binding);
			updateMeta();
			pushTopicIconState(ctx, { force: true });
		} catch {
			// Defer rebind until user runs /telegram again.
		}
	}

	async function reloadBridgeFromTelegram() {
		const ctx = state.lastCtx;
		if (!ctx) return;

		const activeBinding =
			typeof state.boundChatId === "number" && typeof state.boundThreadId === "number"
				? {
					chatId: state.boundChatId,
					messageThreadId: state.boundThreadId,
					title: state.boundTopicTitle ?? undefined,
				}
				: getLatestTopicBinding(ctx);

		disconnect(true);

		try {
			await connectPersistent(ctx);
			updateMeta();
			if (activeBinding) {
				applyTopicBinding(activeBinding);
				persistTopicBinding(activeBinding);
				await bindTopicInDaemon(activeBinding);
			}
			pushTopicIconState(ctx, { force: true });
			updateUiStatus(ctx);
			notify(ctx, "Telegram bridge reloaded.", "info");
		} catch (error) {
			notify(ctx, `Failed to reload Telegram bridge: ${String(error)}`, "error");
		}
	}

	async function restartDaemonFromCommand(ctx: ExtensionCommandContext) {
		const activeBinding = getCurrentTopicBinding() ?? getLatestTopicBinding(ctx);
		const reconnectWasEnabled = state.autoReconnectEnabled;
		state.autoReconnectEnabled = false;

		try {
			if (state.socket && !state.socket.destroyed) {
				state.suppressDisconnectNotice = true;
				send({ type: "shutdown" });
			} else if (await canConnectSocket()) {
				await sendEphemeral({ type: "shutdown" });
			}
		} catch {
			// Ignore shutdown request failures; we'll still try to reconnect.
		}

		disconnect(true);

		const waitStart = Date.now();
		while (Date.now() - waitStart < 10_000) {
			if (!(await canConnectSocket())) break;
			await sleep(150);
		}

		try {
			await connectPersistent(ctx);
			updateMeta();
			if (activeBinding) {
				applyTopicBinding(activeBinding);
				persistTopicBinding(activeBinding);
				await bindTopicInDaemon(activeBinding);
			}
			pushTopicIconState(ctx, { force: true });
			updateUiStatus(ctx);
			notify(ctx, "Telegram daemon restarted and reconnected.", "info");
		} catch (error) {
			notify(ctx, `Failed to restart Telegram daemon: ${String(error)}`, "error");
		} finally {
			state.autoReconnectEnabled = reconnectWasEnabled;
		}
	}

	async function connectPersistent(ctx?: ExtensionContext | ExtensionCommandContext) {
		if (state.socket && !state.socket.destroyed) return;

		await ensureDaemonRunning(daemonPath);

		const socket = net.connect(SOCKET_PATH);
		createJsonlReader(socket, handleDaemonMessage);

		await new Promise<void>((resolve, reject) => {
			socket.once("connect", () => resolve());
			socket.once("error", (error) => reject(error));
		});

		state.socket = socket;

		let handledDisconnect = false;
		const handleSocketDisconnect = (reason: "close" | "error") => {
			if (handledDisconnect) return;
			handledDisconnect = true;

			const silent = state.suppressDisconnectNotice;
			state.suppressDisconnectNotice = false;
			disconnect(false);

			if (!silent && state.autoReconnectEnabled) {
				void attemptAutoReconnect(reason);
			}
		};

		socket.once("close", () => {
			handleSocketDisconnect("close");
		});

		socket.once("error", () => {
			handleSocketDisconnect("error");
		});

		jsonlWrite(socket, {
			type: "register",
			windowId: state.windowId,
			cwd: process.cwd(),
			sessionName: pi.getSessionName() ?? undefined,
			busy: state.busy,
			modelLabel: getModelLabel(ctx ?? state.lastCtx),
			thinkingLevel: getThinkingLevelLabel(pi),
		});
		pushTopicIconState(ctx ?? state.lastCtx, { force: true });

		state.autoReconnectEnabled = true;
		updateUiStatus(ctx ?? state.lastCtx);
	}

	async function requestPin(): Promise<{ code: string; expiresAt: number } | null> {
		if (!state.socket || state.socket.destroyed) return null;

		return await new Promise((resolve) => {
			const timeout = setTimeout(() => {
				daemonHandlers.delete(handler);
				resolve(null);
			}, 15_000);

			const handler = (message: DaemonToClientMessage) => {
				if (message.type === "pin") {
					clearTimeout(timeout);
					daemonHandlers.delete(handler);
					resolve({ code: message.code, expiresAt: message.expiresAt });
				}
				if (message.type === "error") {
					clearTimeout(timeout);
					daemonHandlers.delete(handler);
					resolve(null);
				}
			};

			daemonHandlers.add(handler);
			send({ type: "request_pin" });
		});
	}

	async function requestTopicCreation(title: string): Promise<{
		chatId: number;
		messageThreadId: number;
		title: string;
	} | null> {
		if (!state.socket || state.socket.destroyed) return null;

		return await new Promise((resolve) => {
			const timeout = setTimeout(() => {
				daemonHandlers.delete(handler);
				resolve(null);
			}, 20_000);

			const handler = (message: DaemonToClientMessage) => {
				if (message.type === "topic_created") {
					clearTimeout(timeout);
					daemonHandlers.delete(handler);
					resolve({
						chatId: message.chatId,
						messageThreadId: message.messageThreadId,
						title: message.title,
					});
				}
				if (message.type === "error") {
					clearTimeout(timeout);
					daemonHandlers.delete(handler);
					resolve(null);
				}
			};

			daemonHandlers.add(handler);
			send({ type: "create_topic", title });
		});
	}

	function handleDaemonMessage(message: DaemonToClientMessage) {
		for (const handler of [...daemonHandlers]) {
			try {
				handler(message);
			} catch {
				// Ignore per-handler errors.
			}
		}

		if (message.type === "registered") {
			state.windowNo = message.windowNo;
			state.ownerUserId = typeof message.ownerUserId === "number" ? message.ownerUserId : null;
			state.forumChatId = typeof message.forumChatId === "number" ? message.forumChatId : null;

			if (typeof message.boundThreadId === "number") {
				state.boundThreadId = message.boundThreadId;
				state.boundChatId = typeof message.forumChatId === "number" ? message.forumChatId : state.boundChatId;
			}

			if (typeof message.boundTopicTitle === "string") {
				state.boundTopicTitle = message.boundTopicTitle;
			}

			if (
				typeof message.boundThreadId !== "number" &&
				typeof state.boundThreadId !== "number"
			) {
				state.boundThreadId = null;
				state.boundChatId = null;
				if (typeof message.boundTopicTitle !== "string") {
					state.boundTopicTitle = null;
				}
			}

			if (typeof state.boundChatId === "number" && typeof state.boundThreadId === "number") {
				persistTopicBinding({
					chatId: state.boundChatId,
					messageThreadId: state.boundThreadId,
					title: state.boundTopicTitle ?? undefined,
				});
			}
			updateUiStatus(state.lastCtx);
			return;
		}

		if (message.type === "topic_created") {
			state.boundChatId = typeof message.chatId === "number" ? message.chatId : null;
			state.boundThreadId = typeof message.messageThreadId === "number" ? message.messageThreadId : null;
			state.boundTopicTitle = typeof message.title === "string" ? message.title : null;
			pushTopicIconState(state.lastCtx, { force: true });
			updateUiStatus(state.lastCtx);
			return;
		}

		if (message.type === "inject") {
			const ctx = state.lastCtx;
			if (!ctx) return;

			const text = message.text.trim();
			if (!text) return;

			notify(ctx, `Telegram ${message.mode === "steer" ? "steer" : "follow-up"}: ${shortText(text)}`);

			try {
				if (!ctx.isIdle()) {
					pi.sendUserMessage(text, { deliverAs: message.mode });
				} else {
					pi.sendUserMessage(text);
				}
			} catch (error) {
				notify(ctx, `Failed to deliver Telegram message: ${String(error)}`, "error");
			}
			return;
		}

		if (message.type === "abort") {
			const ctx = state.lastCtx;
			if (!ctx) return;
			ctx.abort();
			notify(ctx, "Telegram requested abort.", "warning");
			return;
		}

		if (message.type === "reload") {
			void reloadBridgeFromTelegram();
			return;
		}

		if (message.type === "session_new") {
			void (async () => {
				try {
					await startNewSessionFromTelegramCommand();
					send({ type: "turn_end", text: "✅ Started a new session and kept this Telegram topic attached." });
				} catch (error) {
					const detail = shortText(String(error), 220);
					send({ type: "turn_end", text: `⚠️ Failed to start new session: ${detail}` });
					notify(state.lastCtx, `Telegram /new failed: ${detail}`, "error");
				}
			})();
			return;
		}

		if (message.type === "voice_setup_required") {
			void handleVoiceSetupRequired(message);
			return;
		}

		if (message.type === "error") {
			notify(state.lastCtx, `Telegram daemon error: ${message.error}`, "error");
		}
	}

	pi.on("session_start", async (_event, ctx) => {
		state.lastCtx = ctx;
		await refreshStateFromConfig();
		await restoreTopicBinding(ctx);
		if (state.socket && !state.socket.destroyed) {
			updateMeta();
			pushTopicIconState(ctx, { force: true });
		}
	});

	pi.on("session_switch", async (_event, ctx) => {
		state.lastCtx = ctx;
		await refreshStateFromConfig();
		await restoreTopicBinding(ctx);
		if (state.socket && !state.socket.destroyed) {
			updateMeta();
			pushTopicIconState(ctx, { force: true });
		}
	});

	pi.on("model_select", async (_event, ctx) => {
		state.lastCtx = ctx;
		if (state.socket && !state.socket.destroyed) {
			updateMeta();
		}
	});

	pi.on("agent_start", async (_event, ctx) => {
		state.lastCtx = ctx;
		state.busy = true;
		if (state.socket && !state.socket.destroyed) {
			updateMeta();
			send({ type: "turn_progress", text: "Thinking…" });
			pushTopicIconState(ctx, { force: true });
		}
	});

	pi.on("tool_call", async (event, ctx) => {
		if (!state.socket || state.socket.destroyed) return;
		const progressText = formatToolProgress(event.toolName, event.input);
		send({ type: "turn_progress", text: progressText });
		pushTopicIconState(ctx);
	});

	pi.on("agent_end", async (_event, ctx) => {
		state.lastCtx = ctx;
		state.busy = false;
		if (state.socket && !state.socket.destroyed) {
			updateMeta();
			pushTopicIconState(ctx, { force: true });
		}
	});

	pi.on("turn_end", async (event: TurnEndEvent) => {
		if (!state.socket || state.socket.destroyed) return;
		const text = extractAssistantText(event.message);
		if (!text) return;
		send({ type: "turn_end", text });
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		state.autoReconnectEnabled = false;
		disconnect();
		updateUiStatus(ctx);
	});

	pi.registerCommand("telegram", {
		description: "Telegram bridge: /telegram [topic|new|pair|status|voice-model|voice-install|restart|stop|unpair]",
		handler: async (args, ctx: ExtensionCommandContext) => {
			state.lastCtx = ctx;
			state.lastCommandCtx = ctx;
			const { subcommand, rest } = splitSubcommand(args);

			if (subcommand === "help") {
				notify(
					ctx,
					[
						"Usage:",
						"/telegram                # create+bind a topic for this session",
						"/telegram topic [title]  # create+bind topic with optional title",
						"/telegram new                  # start a fresh pi session and keep this topic",
						"/telegram pair                 # pair owner via PIN",
						"/telegram status               # show status",
						"/telegram voice-model [model]  # get/set whisper model",
						"/telegram voice-install [model] # install whisper.cpp voice setup",
						"/telegram restart              # restart daemon and reconnect",
						"/telegram stop                 # disconnect this window",
						"/telegram unpair               # clear owner pairing",
					].join("\n"),
				);
				return;
			}

			if (subcommand === "status") {
				const config = await loadConfig();
				await refreshStateFromConfig();
				const tokenState = config.botToken ? "configured" : "missing";
				const daemonState = (await canConnectSocket()) ? "running" : "stopped";
				const windowState = state.windowNo !== null && state.socket && !state.socket.destroyed
					? `connected (window ${state.windowNo})`
					: "disconnected";

				const ownerState = state.ownerUserId !== null ? `paired (user ${state.ownerUserId})` : "unpaired";
				const forumState = state.forumChatId !== null ? `set (${state.forumChatId})` : "not set";
				const topicState = typeof state.boundThreadId === "number"
					? `bound (${state.boundThreadId}${state.boundTopicTitle ? `: ${state.boundTopicTitle}` : ""})`
					: "not bound";

				const configuredModel = config.whisperModelPath?.trim();
				const defaultModelPath = path.join(EXTENSION_DIR, "whisper.cpp", "models", "ggml-large-v3-turbo.bin");
				const activeModelPath = configuredModel
					? resolveWhisperModelPath(configuredModel).path
					: defaultModelPath;
				const activeModelLabel = configuredModel || "large-v3-turbo (default)";
				const modelExists = await pathExists(activeModelPath);
				const contextPercent = getContextPercent(ctx);
				const usageState = state.busy ? "thinking" : stateFromContextPercent(contextPercent);
				const sessionModelLabel = getModelLabel(ctx) ?? "unknown";
				const sessionThinkingLevel = getThinkingLevelLabel(pi) ?? "unknown";

				notify(
					ctx,
					[
						`Telegram config: token ${tokenState}, ${ownerState}`,
						`Forum group: ${forumState}`,
						`Daemon: ${daemonState}`,
						`This window: ${windowState}`,
						`Topic: ${topicState}`,
						`Session model: ${sessionModelLabel}`,
						`Thinking level: ${sessionThinkingLevel}`,
						`Topic icon state: ${usageState}${typeof contextPercent === "number" ? ` (${contextPercent.toFixed(1)}%)` : ""}`,
						`Voice model: ${activeModelLabel}${modelExists ? "" : " (missing)"}`,
					].join("\n"),
				);
				return;
			}

			if (subcommand === "voice-model" || subcommand === "model") {
				const config = await loadConfig();
				const requested = rest.trim();
				const defaultModelPath = path.join(EXTENSION_DIR, "whisper.cpp", "models", "ggml-large-v3-turbo.bin");

				if (!requested) {
					const configuredModel = config.whisperModelPath?.trim();
					const resolvedPath = configuredModel
						? resolveWhisperModelPath(configuredModel).path
						: defaultModelPath;
					const exists = await pathExists(resolvedPath);
					notify(
						ctx,
						[
							`Voice model: ${configuredModel || "large-v3-turbo (default)"}${exists ? "" : " (missing)"}`,
							`Aliases: ${WHISPER_MODEL_ALIASES.join(", ")}`,
							"Usage:",
							"/telegram voice-model large-v3-turbo",
							"/telegram voice-model /abs/path/to/model.bin",
						].join("\n"),
					);
					return;
				}

				let resolved: { path: string; alias?: string };
				try {
					resolved = resolveWhisperModelPath(requested);
				} catch (error) {
					notify(ctx, `Invalid model value: ${String(error)}`, "error");
					return;
				}

				config.whisperModelPath = resolved.alias || resolved.path;
				await saveConfig(config);

				const exists = await pathExists(resolved.path);
				notify(
					ctx,
					exists
						? `Voice model set: ${config.whisperModelPath}`
						: `Voice model set: ${config.whisperModelPath} (file missing at ${resolved.path})`,
					exists ? "info" : "warning",
				);
				return;
			}

			if (subcommand === "voice-install" || subcommand === "voice-setup" || subcommand === "install-voice") {
				const requestedAlias = rest.trim() || undefined;
				await runWhisperInstallFlow(ctx, { requestedAlias });
				return;
			}

			if (subcommand === "new") {
				try {
					await startNewSessionFromTelegramCommand();
					notify(ctx, "Started a new session and preserved Telegram topic binding.", "info");
				} catch (error) {
					notify(ctx, `Failed to start new session: ${String(error)}`, "error");
				}
				return;
			}

			if (subcommand === "restart") {
				await restartDaemonFromCommand(ctx);
				return;
			}

			if (subcommand === "stop") {
				state.autoReconnectEnabled = false;
				disconnect();
				notify(ctx, "Telegram bridge disconnected for this window.");
				return;
			}

			if (subcommand === "unpair") {
				const config = await loadConfig();
				delete config.ownerUserId;
				delete config.ownerDmChatId;
				delete config.pairedChatId;
				await saveConfig(config);

				if (await canConnectSocket()) {
					try {
						await sendEphemeral({ type: "unpair" });
					} catch {
						// Daemon might be down; local config is still authoritative.
					}
				}

				state.ownerUserId = null;
				notify(ctx, "Owner pairing cleared.");
				return;
			}

			if (subcommand === "pair") {
				const config = await loadConfig();
				await refreshStateFromConfig();

				if (!config.botToken) {
					if (!ctx.hasUI) {
						throw new Error(`Missing botToken. Create ${CONFIG_PATH} with {\"botToken\": \"...\"}.`);
					}

					const token = await ctx.ui.input("Telegram bot token", `Paste token (saved to ${CONFIG_PATH})`);
					if (!token?.trim()) {
						notify(ctx, "Cancelled.");
						return;
					}
					await saveConfig({ ...config, botToken: token.trim() });
				}

				await connectPersistent(ctx);
				updateMeta();

				if (state.ownerUserId === null) {
					const pin = await requestPin();
					if (!pin) {
						notify(ctx, "Failed to request pairing PIN from daemon.", "error");
						return;
					}

					if (ctx.hasUI) {
						ctx.ui.notify(`Telegram pairing PIN: /pin ${pin.code} (valid 60s)`);
						ctx.ui.setWidget("telegram", [
							`1) In Telegram DM with your bot: /pin ${pin.code}`,
							"2) In your forum supergroup: /setforum",
							"3) Back here: /telegram (creates a topic for this session)",
						]);
					}
					return;
				}

				notify(ctx, "Already paired. Run /telegram to create a topic for this session.");
				if (state.forumChatId === null) {
					notify(ctx, "Forum group not set yet. In Telegram supergroup run /setforum.", "warning");
				}
				return;
			}

			if (subcommand === "topic") {
				await connectPersistent(ctx);
				updateMeta();
				await refreshStateFromConfig();

				if (state.ownerUserId === null) {
					notify(ctx, "Not paired yet. Run /telegram pair first.", "warning");
					return;
				}

				if (state.forumChatId === null) {
					notify(ctx, "Forum group not set. In Telegram supergroup run /setforum.", "warning");
					return;
				}

				const base = deriveSessionTopicBase(ctx, pi.getSessionName(), process.cwd(), rest);
				const title = buildTopicTitle(base);
				const topic = await requestTopicCreation(title);
				if (!topic) {
					notify(ctx, "Failed to create Telegram topic. Check bot admin rights + forum mode.", "error");
					return;
				}

				state.boundChatId = topic.chatId;
				state.boundThreadId = topic.messageThreadId;
				state.boundTopicTitle = topic.title;
				persistTopicBinding({
					chatId: topic.chatId,
					messageThreadId: topic.messageThreadId,
					title: topic.title,
				});
				pushTopicIconState(ctx, { force: true });
				updateUiStatus(ctx);

				if (ctx.hasUI) {
					ctx.ui.notify(`Telegram topic connected: ${topic.title} (#${topic.messageThreadId})`, "info");
					ctx.ui.setWidget("telegram", undefined);
				}
				return;
			}

			notify(ctx, `Unknown subcommand: ${subcommand}. Use /telegram help`, "error");
		},
	});
}
