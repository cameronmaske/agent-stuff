import fs from "node:fs";
import * as fsp from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import TelegramBot from "node-telegram-bot-api";

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
const MANAGED_TOPICS_PATH = path.join(EXTENSION_DIR, "managed-topics.json");
const PROJECT_PROFILES_PATH = path.join(EXTENSION_DIR, "project-profiles.json");
const PROJECT_TOPICS_PATH = path.join(EXTENSION_DIR, "project-topics.json");
const DAEMON_LOCK_PATH = path.join(RUN_DIR, "telegram-daemon.lock");
const LOG_PATH = path.join(EXTENSION_DIR, "daemon.log");
const LOG_ROTATE_PATH = path.join(EXTENSION_DIR, "daemon.log.1");
const LOG_MAX_BYTES = 2 * 1024 * 1024;

const DAEMON_LOCK_ID = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
let daemonLockHeld = false;

const WHISPER_MODEL_ALIASES = new Set([
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
]);

const STATUS_EDIT_MIN_INTERVAL_MS = 3500;
const STATUS_IDLE_DELETE_DELAY_MS = 1500;
const STALE_TOPIC_SWEEP_INTERVAL_MS = 60_000;
const DEFAULT_STALE_TOPIC_GRACE_SEC = 300;
const PROJECT_RPC_RESPONSE_TIMEOUT_MS = 30_000;
const PROJECT_SETUP_DEFAULT_STORAGE_ROOT = path.join(AGENT_DIR, "telegram-projects");
const TOPIC_ICON_STATES = new Set(["thinking", "green", "yellow", "red"]);
const DEFAULT_TOPIC_ICON_EMOJIS = {
	thinking: "🧠",
	green: "✅",
	yellow: "⚡️",
	red: "‼️",
};

/** @typedef {{
 *   botToken?: string;
 *   ownerUserId?: number;
 *   ownerDmChatId?: number;
 *   forumChatId?: number;
 *   pairedChatId?: number;
 *   voiceTranscribeCommand?: string;
 *   voiceTranscribeTimeoutSec?: number;
 *   whisperModelPath?: string;
 *   staleTopicCleanupEnabled?: boolean;
 *   staleTopicGraceSec?: number;
 *   topicIconEnabled?: boolean;
 *   topicIconEmojis?: {
 *     thinking?: string;
 *     green?: string;
 *     yellow?: string;
 *     red?: string;
 *   };
 *   topicIconCustomEmojiIds?: {
 *     thinking?: string;
 *     green?: string;
 *     yellow?: string;
 *     red?: string;
 *   };
 * }} Config
 */

/** @typedef {"thinking" | "green" | "yellow" | "red"} TopicIconState */

/** @typedef {{
 *   chatId: number;
 *   threadId: number;
 *   messageId: number;
 *   sourceMessageId?: number;
 *   startedAt: number;
 *   currentText: string;
 *   lastSentText: string;
 *   lastEditAt: number;
 *   pendingText?: string;
 *   pendingTimer?: NodeJS.Timeout;
 *   idleDeleteTimer?: NodeJS.Timeout;
 * }} TurnStatus
 */

/** @typedef {{
 *   windowId: string;
 *   windowNo: number;
 *   socket: net.Socket;
 *   cwd: string;
 *   sessionName?: string;
 *   busy: boolean;
 *   lastTurnText?: string;
 *   lastTurnSeq: number;
 *   boundChatId?: number;
 *   boundThreadId?: number;
 *   boundTopicTitle?: string;
 *   activeStatus?: TurnStatus;
 *   pendingTurns: number;
 *   modelLabel?: string;
 *   thinkingLevel?: string;
 *   topicIconState?: TopicIconState;
 *   topicIconContextPercent?: number;
 *   topicIconLastAppliedState?: TopicIconState;
 *   topicIconLastAppliedId?: string;
 *   topicIconLastEditAt?: number;
 *   topicIconPendingState?: TopicIconState;
 *   topicIconPendingTimer?: NodeJS.Timeout;
 *   topicIconUpdateInFlight?: boolean;
 *   topicIconInFlightState?: TopicIconState;
 *   topicIconInFlightId?: string;
 * }} WindowState
 */

/** @typedef {{
 *   chatId: number;
 *   threadId: number;
 *   title?: string;
 *   createdAt: number;
 *   updatedAt: number;
 *   lastBoundAt: number;
 *   unboundSince?: number;
 * }} ManagedTopic
 */

/** @typedef {{
 *   projectKey: string;
 *   projectName: string;
 *   cwd: string;
 *   storageDir: string;
 *   sessionDir: string;
 *   createdAt: number;
 *   updatedAt: number;
 * }} ProjectProfile
 */

/** @typedef {{
 *   chatId: number;
 *   threadId: number;
 *   title?: string;
 *   projectKey: string;
 *   projectName: string;
 *   mode: "setup" | "active";
 *   setupStep?: "awaiting_cwd" | "awaiting_storage";
 *   cwd?: string;
 *   storageDir?: string;
 *   sessionDir?: string;
 *   sessionFile?: string;
 *   createdAt: number;
 *   updatedAt: number;
 *   lastUsedAt: number;
 * }} ProjectTopic
 */

/** @typedef {{
 *   id: string;
 *   key: string;
 *   chatId: number;
 *   threadId: number;
 *   projectKey: string;
 *   projectName: string;
 *   cwd: string;
 *   sessionDir: string;
 *   sessionFile?: string;
 *   child: import("node:child_process").ChildProcessWithoutNullStreams;
 *   pendingResponses: Map<string, {
 *     resolve: (response: any) => void;
 *     reject: (error: Error) => void;
 *     timer: NodeJS.Timeout;
 *     commandType: string;
 *   }>;
 *   nextRequestId: number;
 *   stdoutBuffer: string;
 *   stderrTail: string;
 *   streaming: boolean;
 *   closing: boolean;
 *   startedAt: number;
 * }} ProjectWorker
 */

/** @param {string} configPath */
async function readConfigFile(configPath) {
	try {
		const raw = await fsp.readFile(configPath, "utf8");
		return /** @type {Config} */ (JSON.parse(raw));
	} catch {
		return null;
	}
}

async function loadConfig() {
	const current = await readConfigFile(CONFIG_PATH);
	if (current) return current;

	const legacy = await readConfigFile(LEGACY_CONFIG_PATH);
	if (legacy) {
		await saveConfig(legacy);
		return legacy;
	}

	return null;
}

/** @param {Config} config */
async function saveConfig(config) {
	await fsp.mkdir(path.dirname(CONFIG_PATH), { recursive: true, mode: 0o700 });
	const tempPath = `${CONFIG_PATH}.tmp`;
	await fsp.writeFile(tempPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
	await fsp.rename(tempPath, CONFIG_PATH);
}

function topicKey(chatId, threadId) {
	return `${chatId}:${threadId}`;
}

async function loadManagedTopics() {
	try {
		const raw = await fsp.readFile(MANAGED_TOPICS_PATH, "utf8");
		const parsed = JSON.parse(raw);
		if (!Array.isArray(parsed)) return [];
		return parsed.filter((entry) => (
			entry &&
			typeof entry === "object" &&
			typeof entry.chatId === "number" &&
			typeof entry.threadId === "number"
		));
	} catch {
		return [];
	}
}

/** @param {Map<string, ManagedTopic>} managedTopics */
async function saveManagedTopics(managedTopics) {
	await fsp.mkdir(path.dirname(MANAGED_TOPICS_PATH), { recursive: true, mode: 0o700 });
	const tempPath = `${MANAGED_TOPICS_PATH}.tmp`;
	const payload = [...managedTopics.values()].map((topic) => ({
		chatId: topic.chatId,
		threadId: topic.threadId,
		title: topic.title,
		createdAt: topic.createdAt,
		updatedAt: topic.updatedAt,
		lastBoundAt: topic.lastBoundAt,
		unboundSince: typeof topic.unboundSince === "number" ? topic.unboundSince : undefined,
	}));
	await fsp.writeFile(tempPath, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
	await fsp.rename(tempPath, MANAGED_TOPICS_PATH);
}

async function loadProjectProfiles() {
	try {
		const raw = await fsp.readFile(PROJECT_PROFILES_PATH, "utf8");
		const parsed = JSON.parse(raw);
		if (!Array.isArray(parsed)) return [];
		return parsed.filter((entry) => (
			entry &&
			typeof entry === "object" &&
			typeof entry.projectKey === "string" &&
			typeof entry.projectName === "string" &&
			typeof entry.cwd === "string" &&
			typeof entry.storageDir === "string" &&
			typeof entry.sessionDir === "string"
		));
	} catch {
		return [];
	}
}

/** @param {Map<string, ProjectProfile>} profiles */
async function saveProjectProfiles(profiles) {
	await fsp.mkdir(path.dirname(PROJECT_PROFILES_PATH), { recursive: true, mode: 0o700 });
	const tempPath = `${PROJECT_PROFILES_PATH}.tmp`;
	const payload = [...profiles.values()].map((profile) => ({
		projectKey: profile.projectKey,
		projectName: profile.projectName,
		cwd: profile.cwd,
		storageDir: profile.storageDir,
		sessionDir: profile.sessionDir,
		createdAt: profile.createdAt,
		updatedAt: profile.updatedAt,
	}));
	await fsp.writeFile(tempPath, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
	await fsp.rename(tempPath, PROJECT_PROFILES_PATH);
}

async function loadProjectTopics() {
	try {
		const raw = await fsp.readFile(PROJECT_TOPICS_PATH, "utf8");
		const parsed = JSON.parse(raw);
		if (!Array.isArray(parsed)) return [];
		return parsed.filter((entry) => (
			entry &&
			typeof entry === "object" &&
			typeof entry.chatId === "number" &&
			typeof entry.threadId === "number" &&
			typeof entry.projectKey === "string" &&
			typeof entry.projectName === "string" &&
			(entry.mode === "setup" || entry.mode === "active")
		));
	} catch {
		return [];
	}
}

/** @param {Map<string, ProjectTopic>} projectTopics */
async function saveProjectTopics(projectTopics) {
	await fsp.mkdir(path.dirname(PROJECT_TOPICS_PATH), { recursive: true, mode: 0o700 });
	const tempPath = `${PROJECT_TOPICS_PATH}.tmp`;
	const payload = [...projectTopics.values()].map((topic) => ({
		chatId: topic.chatId,
		threadId: topic.threadId,
		title: topic.title,
		projectKey: topic.projectKey,
		projectName: topic.projectName,
		mode: topic.mode,
		setupStep: topic.setupStep,
		cwd: topic.cwd,
		storageDir: topic.storageDir,
		sessionDir: topic.sessionDir,
		sessionFile: topic.sessionFile,
		createdAt: topic.createdAt,
		updatedAt: topic.updatedAt,
		lastUsedAt: topic.lastUsedAt,
	}));
	await fsp.writeFile(tempPath, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
	await fsp.rename(tempPath, PROJECT_TOPICS_PATH);
}

/** @param {string} line */
function safeJsonParse(line) {
	try {
		return JSON.parse(line);
	} catch {
		return null;
	}
}

/** @param {net.Socket} socket */
function makeJsonlWriter(socket) {
	return (obj) => {
		try {
			socket.write(`${JSON.stringify(obj)}\n`);
		} catch {
			// Ignore socket write errors.
		}
	};
}

function formatLogArg(value) {
	if (value instanceof Error) {
		return value.stack || `${value.name}: ${value.message}`;
	}
	if (typeof value === "string") {
		return value;
	}
	try {
		return JSON.stringify(value);
	} catch {
		return String(value);
	}
}

function maybeRotateLogFile() {
	try {
		if (!fs.existsSync(LOG_PATH)) return;
		const stat = fs.statSync(LOG_PATH);
		if (stat.size < LOG_MAX_BYTES) return;
		try {
			fs.unlinkSync(LOG_ROTATE_PATH);
		} catch {
			// Ignore missing rotate target.
		}
		fs.renameSync(LOG_PATH, LOG_ROTATE_PATH);
	} catch {
		// Ignore rotation failures.
	}
}

/** @param {"debug" | "info" | "warn" | "error"} level @param {unknown[]} args */
function appendDaemonLog(level, args) {
	try {
		maybeRotateLogFile();
		const line = `${new Date().toISOString()} [${level}] ${args.map((arg) => formatLogArg(arg)).join(" ")}\n`;
		fs.appendFileSync(LOG_PATH, line, { mode: 0o600 });
	} catch {
		// Ignore logging failures.
	}
}

const originalConsoleLog = console.log.bind(console);
const originalConsoleInfo = console.info.bind(console);
const originalConsoleWarn = console.warn.bind(console);
const originalConsoleError = console.error.bind(console);

console.log = (...args) => {
	appendDaemonLog("info", args);
	originalConsoleLog(...args);
};

console.info = (...args) => {
	appendDaemonLog("info", args);
	originalConsoleInfo(...args);
};

console.warn = (...args) => {
	appendDaemonLog("warn", args);
	originalConsoleWarn(...args);
};

console.error = (...args) => {
	appendDaemonLog("error", args);
	originalConsoleError(...args);
};

function isPidAlive(pid) {
	if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		if (error && typeof error === "object" && error.code === "EPERM") {
			return true;
		}
		return false;
	}
}

async function readDaemonLock() {
	try {
		const raw = await fsp.readFile(DAEMON_LOCK_PATH, "utf8");
		const parsed = JSON.parse(raw);
		if (!parsed || typeof parsed !== "object") return null;
		return parsed;
	} catch {
		return null;
	}
}

function readDaemonLockSync() {
	try {
		const raw = fs.readFileSync(DAEMON_LOCK_PATH, "utf8");
		const parsed = JSON.parse(raw);
		if (!parsed || typeof parsed !== "object") return null;
		return parsed;
	} catch {
		return null;
	}
}

function sleepMs(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function isDaemonSocketReachable() {
	if (!fs.existsSync(SOCKET_PATH)) return false;

	return await new Promise((resolve) => {
		const socket = net.connect(SOCKET_PATH);
		let settled = false;

		const done = (value) => {
			if (settled) return;
			settled = true;
			socket.removeAllListeners();
			try {
				socket.end();
			} catch {
				// Ignore close failures.
			}
			try {
				socket.destroy();
			} catch {
				// Ignore destroy failures.
			}
			resolve(value);
		};

		socket.once("connect", () => done(true));
		socket.once("error", () => done(false));

		setTimeout(() => done(false), 400);
	});
}

function releaseDaemonLock() {
	if (!daemonLockHeld) return;
	try {
		const lock = readDaemonLockSync();
		if (
			lock &&
			typeof lock.lockId === "string" &&
			lock.lockId !== DAEMON_LOCK_ID
		) {
			daemonLockHeld = false;
			return;
		}
		if (fs.existsSync(DAEMON_LOCK_PATH)) {
			fs.unlinkSync(DAEMON_LOCK_PATH);
		}
	} catch {
		// Ignore lock release errors.
	}
	daemonLockHeld = false;
}

async function acquireDaemonLock() {
	await fsp.mkdir(RUN_DIR, { recursive: true, mode: 0o700 });

	const deadline = Date.now() + 12_000;
	let warnedWaitingForRelease = false;

	while (Date.now() < deadline) {
		try {
			const handle = await fsp.open(DAEMON_LOCK_PATH, "wx", 0o600);
			try {
				await handle.writeFile(`${JSON.stringify({
					pid: process.pid,
					lockId: DAEMON_LOCK_ID,
					createdAt: Date.now(),
					socketPath: SOCKET_PATH,
				})}\n`);
			} finally {
				await handle.close();
			}
			daemonLockHeld = true;
			console.info(`[telegram] Acquired daemon lock at ${DAEMON_LOCK_PATH} (pid ${process.pid})`);
			return true;
		} catch (error) {
			if (!(error && typeof error === "object" && error.code === "EEXIST")) {
				throw error;
			}

			const lock = await readDaemonLock();
			const existingPid = lock && typeof lock.pid === "number" ? lock.pid : undefined;
			const socketReachable = await isDaemonSocketReachable();

			if (isPidAlive(existingPid)) {
				if (socketReachable) {
					console.error(`[telegram] Daemon lock held by pid ${existingPid}; exiting.`);
					return false;
				}

				if (!warnedWaitingForRelease) {
					console.warn(
						`[telegram] Lock held by pid ${existingPid} but socket is unavailable; waiting for release...`,
					);
					warnedWaitingForRelease = true;
				}
				await sleepMs(250);
				continue;
			}

			try {
				await fsp.unlink(DAEMON_LOCK_PATH);
				console.warn("[telegram] Removed stale daemon lock file.");
			} catch {
				// Ignore stale lock cleanup races.
			}

			await sleepMs(100);
		}
	}

	console.error(`[telegram] Failed to acquire daemon lock at ${DAEMON_LOCK_PATH}`);
	return false;
}

/** @param {string} text @param {number} max */
function chunkText(text, max = 3500) {
	const chunks = [];
	let index = 0;
	while (index < text.length) {
		chunks.push(text.slice(index, index + max));
		index += max;
	}
	return chunks;
}

function shortText(text, max = 140) {
	if (text.length <= max) return text;
	return `${text.slice(0, max - 1)}…`;
}

function normalizeProjectName(name) {
	const compact = String(name ?? "").replace(/\s+/g, " ").trim();
	return shortText(compact, 80);
}

function projectNameToKey(name) {
	return normalizeProjectName(name).toLowerCase();
}

function projectNameToSlug(name) {
	const normalized = normalizeProjectName(name)
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
	return normalized || "project";
}

function defaultProjectStorageDir(projectName) {
	return path.join(PROJECT_SETUP_DEFAULT_STORAGE_ROOT, projectNameToSlug(projectName));
}

function defaultProjectSessionDir(projectName, storageDir) {
	const compact = typeof storageDir === "string" && storageDir.trim() ? storageDir.trim() : "";
	if (compact) {
		return path.join(compact, ".pi-sessions");
	}
	return path.join(PROJECT_SETUP_DEFAULT_STORAGE_ROOT, `${projectNameToSlug(projectName)}-sessions`);
}

function resolveUserPathInput(inputPath) {
	const trimmed = String(inputPath ?? "").trim();
	if (!trimmed) return null;
	const expanded = expandHomePath(trimmed);
	if (path.isAbsolute(expanded)) {
		return path.normalize(expanded);
	}
	return path.resolve(os.homedir(), expanded);
}

function sanitizeProjectTopicTitle(projectName) {
	const base = normalizeProjectName(projectName);
	const candidate = base ? `project: ${base}` : "project";
	const trimmed = candidate.slice(0, 120).trim();
	return trimmed || "project";
}

function parseProjectCommand(text) {
	const match = text.match(/^\/project(?:@[A-Za-z0-9_]+)?(?:\s+([\s\S]+))?$/i);
	if (!match) return null;
	const args = String(match[1] ?? "").trim();
	if (!args) return { subcommand: "", rest: "" };
	const [subcommand, ...restParts] = args.split(/\s+/g);
	return {
		subcommand: String(subcommand ?? "").toLowerCase(),
		rest: restParts.join(" ").trim(),
	};
}

function extractAssistantTextFromRpcMessage(message) {
	if (!message || typeof message !== "object") return "";
	if (message.role !== "assistant") return "";
	if (!Array.isArray(message.content)) return "";
	return message.content
		.map((part) => {
			if (part && typeof part === "object" && part.type === "text" && typeof part.text === "string") {
				return part.text;
			}
			return "";
		})
		.filter((value) => value.length > 0)
		.join("\n")
		.trim();
}

function formatElapsed(ms) {
	const totalSeconds = Math.max(0, Math.floor(ms / 1000));
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	if (minutes >= 60) {
		const hours = Math.floor(minutes / 60);
		const remMinutes = minutes % 60;
		return `${hours}h ${String(remMinutes).padStart(2, "0")}m`;
	}
	if (minutes > 0) {
		return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
	}
	return `${seconds}s`;
}

function normalizeProgressText(text) {
	if (typeof text !== "string") return "Thinking…";
	const compact = text.replace(/\s+/g, " ").trim();
	return compact ? shortText(compact, 220) : "Thinking…";
}

/** @param {unknown} value @returns {value is TopicIconState} */
function isTopicIconState(value) {
	return typeof value === "string" && TOPIC_ICON_STATES.has(value);
}

/** @param {number} value */
function clampContextPercent(value) {
	if (!Number.isFinite(value)) return 0;
	return Math.max(0, Math.min(100, value));
}

/** @param {number | undefined} percent */
function topicIconStateFromPercent(percent) {
	if (typeof percent !== "number") return "green";
	const clamped = clampContextPercent(percent);
	if (clamped >= 80) return "red";
	if (clamped >= 60) return "yellow";
	return "green";
}

function isTopicIconEnabled() {
	return config?.topicIconEnabled !== false;
}

function getConfiguredTopicIconEmojis() {
	if (!config || !config.topicIconEmojis || typeof config.topicIconEmojis !== "object") return null;
	return config.topicIconEmojis;
}

function getConfiguredTopicIconCustomIds() {
	if (!config || !config.topicIconCustomEmojiIds || typeof config.topicIconCustomEmojiIds !== "object") return null;
	return config.topicIconCustomEmojiIds;
}

/** @param {TopicIconState} state */
function getConfiguredTopicIconEmoji(state) {
	const map = getConfiguredTopicIconEmojis();
	if (!map) return undefined;
	const value = map[state];
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed || undefined;
}

/** @param {TopicIconState} state */
function getConfiguredTopicIconCustomId(state) {
	const map = getConfiguredTopicIconCustomIds();
	if (!map) return undefined;
	const value = map[state];
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed || undefined;
}

/** @param {TurnStatus} status */
function clearTurnStatusTimers(status) {
	if (status.pendingTimer) {
		clearTimeout(status.pendingTimer);
		status.pendingTimer = undefined;
	}
	if (status.idleDeleteTimer) {
		clearTimeout(status.idleDeleteTimer);
		status.idleDeleteTimer = undefined;
	}
}

/** @param {TurnStatus} status @param {string} detail */
function composeTurnStatusMessage(status, detail) {
	return [
		"⏳ Working…",
		detail,
		`⏱️ ${formatElapsed(Date.now() - status.startedAt)}`,
	].join("\n");
}

function isHarmlessEditError(error) {
	const message = String(error?.message ?? error).toLowerCase();
	return (
		message.includes("message is not modified") ||
		message.includes("message to edit not found") ||
		message.includes("message can't be edited")
	);
}

/** @param {WindowState} windowState @param {string} nextText */
async function applyTurnStatusEdit(windowState, nextText) {
	if (!bot) return;
	const status = windowState.activeStatus;
	if (!status) return;

	try {
		await bot.editMessageText(nextText, {
			chat_id: status.chatId,
			message_id: status.messageId,
		});
		status.lastEditAt = Date.now();
		status.lastSentText = nextText;
	} catch (error) {
		if (!isHarmlessEditError(error)) {
			console.error("[telegram] Failed to edit status message", error);
		}
	}
}

/** @param {WindowState} windowState @param {string} detail @param {{ force?: boolean }} [options] */
function scheduleTurnStatusUpdate(windowState, detail, options = {}) {
	const status = windowState.activeStatus;
	if (!status) return;

	const normalized = normalizeProgressText(detail);
	status.currentText = normalized;
	const nextText = composeTurnStatusMessage(status, normalized);
	if (nextText === status.lastSentText && !options.force) return;

	const now = Date.now();
	const waitMs = Math.max(0, status.lastEditAt + STATUS_EDIT_MIN_INTERVAL_MS - now);
	if (options.force || waitMs === 0) {
		clearTurnStatusTimers(status);
		void applyTurnStatusEdit(windowState, nextText);
		return;
	}

	status.pendingText = nextText;
	if (status.pendingTimer) return;

	status.pendingTimer = setTimeout(() => {
		const active = windowState.activeStatus;
		if (!active) return;
		active.pendingTimer = undefined;
		const textToSend = active.pendingText;
		active.pendingText = undefined;
		if (textToSend) {
			void applyTurnStatusEdit(windowState, textToSend);
		}
	}, waitMs);
}

/** @param {WindowState} windowState */
async function deleteTurnStatus(windowState) {
	const status = windowState.activeStatus;
	windowState.pendingTurns = 0;
	if (!status) return;

	clearTurnStatusTimers(status);
	windowState.activeStatus = undefined;

	if (!bot) return;
	try {
		await bot.deleteMessage(status.chatId, status.messageId);
	} catch {
		// Ignore delete failures (permissions/race).
	}
}

/** @param {WindowState} windowState */
function scheduleIdleStatusCleanup(windowState) {
	const status = windowState.activeStatus;
	if (!status) return;

	if (status.idleDeleteTimer) {
		clearTimeout(status.idleDeleteTimer);
	}

	const delayMs = windowState.pendingTurns > 0 ? 45_000 : STATUS_IDLE_DELETE_DELAY_MS;
	status.idleDeleteTimer = setTimeout(() => {
		const active = windowState.activeStatus;
		if (!active) return;
		if (windowState.busy) return;
		void deleteTurnStatus(windowState);
	}, delayMs);
}

/** @param {WindowState} windowState @param {import("node-telegram-bot-api").Message} message @param {string} detail */
async function startTurnStatus(windowState, message, detail) {
	windowState.pendingTurns = (windowState.pendingTurns || 0) + 1;

	if (!bot) return;
	if (typeof windowState.boundChatId !== "number" || typeof windowState.boundThreadId !== "number") return;

	if (windowState.activeStatus) {
		if (windowState.activeStatus.idleDeleteTimer) {
			clearTimeout(windowState.activeStatus.idleDeleteTimer);
			windowState.activeStatus.idleDeleteTimer = undefined;
		}
		const queuedCount = Math.max(0, windowState.pendingTurns - 1);
		if (queuedCount > 0) {
			const suffix = queuedCount === 1 ? "" : "s";
			scheduleTurnStatusUpdate(windowState, `Queued ${queuedCount} more request${suffix}…`);
		}
		return;
	}

	const status = /** @type {TurnStatus} */ ({
		chatId: windowState.boundChatId,
		threadId: windowState.boundThreadId,
		sourceMessageId: typeof message.message_id === "number" ? message.message_id : undefined,
		messageId: 0,
		startedAt: Date.now(),
		currentText: normalizeProgressText(detail),
		lastSentText: "",
		lastEditAt: 0,
	});

	const text = composeTurnStatusMessage(status, status.currentText);
	try {
		const sent = await bot.sendMessage(status.chatId, text, {
			message_thread_id: status.threadId,
			reply_to_message_id: status.sourceMessageId,
		});
		status.messageId = sent.message_id;
		status.lastSentText = text;
		status.lastEditAt = Date.now();
		windowState.activeStatus = status;
	} catch {
		// Fallback without reply target if Telegram rejects reply_to_message_id.
		const sent = await bot.sendMessage(status.chatId, text, {
			message_thread_id: status.threadId,
		});
		status.messageId = sent.message_id;
		status.lastSentText = text;
		status.lastEditAt = Date.now();
		windowState.activeStatus = status;
	}
}

function expandHomePath(inputPath) {
	if (inputPath === "~") return os.homedir();
	if (inputPath.startsWith("~/")) {
		return path.join(os.homedir(), inputPath.slice(2));
	}
	return inputPath;
}

function summarizeStderr(stderr) {
	const trimmed = stderr.trim();
	if (!trimmed) return "";
	const lines = trimmed
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line) => line.length > 0);
	if (lines.length === 0) return "";
	const tail = lines.slice(-3).join(" | ");
	return shortText(tail, 260);
}

/** @param {string} value */
function shellQuote(value) {
	return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}

/**
 * @param {string} command
 * @param {number} timeoutMs
 * @param {Record<string, string>} [envOverrides]
 * @returns {Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }>}
 */
async function runShellCommand(command, timeoutMs, envOverrides = {}) {
	return await new Promise((resolve) => {
		const child = spawn("bash", ["-lc", command], {
			stdio: ["ignore", "pipe", "pipe"],
			env: { ...process.env, ...envOverrides },
		});

		let stdout = "";
		let stderr = "";
		let timedOut = false;

		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk) => {
			stdout += chunk;
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk;
		});

		const timer = setTimeout(() => {
			timedOut = true;
			try {
				child.kill("SIGTERM");
			} catch {
				// Ignore kill failures.
			}
			setTimeout(() => {
				if (!child.killed) {
					try {
						child.kill("SIGKILL");
					} catch {
						// Ignore kill failures.
					}
				}
			}, 1000);
		}, timeoutMs);

		child.on("close", (code) => {
			clearTimeout(timer);
			resolve({ code, stdout, stderr, timedOut });
		});

		child.on("error", (error) => {
			clearTimeout(timer);
			resolve({ code: null, stdout, stderr: `${stderr}\n${String(error?.message ?? error)}`, timedOut });
		});
	});
}

/**
 * @param {Config} config
 * @param {string} inputPath
 * @param {{ chatId: number; threadId?: number }} context
 */
function renderVoiceCommand(config, inputPath, context) {
	const template = config.voiceTranscribeCommand?.trim();
	if (!template) {
		return null;
	}

	let command = template;
	command = command.replaceAll("{input}", shellQuote(inputPath));
	command = command.replaceAll("{chatId}", String(context.chatId));
	command = command.replaceAll("{threadId}", String(context.threadId ?? ""));

	if (!template.includes("{input}")) {
		command += ` ${shellQuote(inputPath)}`;
	}

	return command;
}

/** @param {Config} config */
function resolveConfiguredWhisperModelPath(config) {
	const configured = config.whisperModelPath?.trim();
	if (!configured) return null;

	if (WHISPER_MODEL_ALIASES.has(configured)) {
		return path.join(EXTENSION_DIR, "whisper.cpp", "models", `ggml-${configured}.bin`);
	}

	const expanded = expandHomePath(configured);
	return path.isAbsolute(expanded) ? expanded : path.resolve(process.cwd(), expanded);
}

/**
 * @param {Config} config
 * @param {string} inputPath
 * @param {{ chatId: number; threadId?: number }} context
 */
async function transcribeVoiceMemo(config, inputPath, context) {
	const command = renderVoiceCommand(config, inputPath, context);
	if (!command) {
		throw new Error(
			"voiceTranscribeCommand is not configured. Set it in ~/.pi/agent/extensions/telegram/config.json",
		);
	}

	const timeoutSec =
		typeof config.voiceTranscribeTimeoutSec === "number" && Number.isFinite(config.voiceTranscribeTimeoutSec)
			? Math.max(10, Math.min(900, Math.floor(config.voiceTranscribeTimeoutSec)))
			: 180;

	const envOverrides = {};
	const whisperModelPath = resolveConfiguredWhisperModelPath(config);
	if (whisperModelPath) {
		envOverrides.WHISPER_MODEL = whisperModelPath;
	}

	const result = await runShellCommand(command, timeoutSec * 1000, envOverrides);
	if (result.timedOut) {
		throw new Error(`Transcription timed out after ${timeoutSec}s`);
	}
	if (result.code !== 0) {
		const stderrSummary = summarizeStderr(result.stderr);
		throw new Error(
			stderrSummary
				? `Transcription failed: ${stderrSummary}`
				: `Transcription failed (code ${result.code})`,
		);
	}

	const transcript = result.stdout.replace(/\s+/g, " ").trim();
	if (!transcript) {
		throw new Error("Transcription returned empty output. Ensure command prints transcript to stdout.");
	}

	return transcript;
}

/** @param {string} text */
function escapeHtml(text) {
	return String(text).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

/** @param {string | undefined} title @param {WindowState} windowState */
function sanitizeTopicTitle(title, windowState) {
	const fallbackBase = windowState.sessionName || path.basename(windowState.cwd) || `window-${windowState.windowNo}`;
	const candidate = (title || "").trim() || `pi ${fallbackBase}`;
	const trimmed = candidate.slice(0, 120).trim();
	return trimmed || `pi window-${windowState.windowNo}`;
}

/** @param {WindowState} windowState */
function windowDisplayName(windowState) {
	return windowState.sessionName || path.basename(windowState.cwd || "") || `window-${windowState.windowNo}`;
}

/** @param {WindowState} windowState */
function windowModelLabel(windowState) {
	const value = typeof windowState.modelLabel === "string" ? windowState.modelLabel.trim() : "";
	return value || "unknown";
}

/** @param {WindowState} windowState */
function windowThinkingLabel(windowState) {
	const value = typeof windowState.thinkingLevel === "string" ? windowState.thinkingLevel.trim() : "";
	return value || "unknown";
}

/** @param {WindowState} windowState */
function formatWindowRuntimeLine(windowState) {
	return `Model: ${windowModelLabel(windowState)} · Thinking: ${windowThinkingLabel(windowState)}`;
}

/** @param {Config} config @param {import("node-telegram-bot-api").Message} message */
function isAuthorizedMessage(config, message) {
	const fromId = message.from?.id;
	if (typeof config.ownerUserId === "number") {
		return fromId === config.ownerUserId;
	}
	if (typeof config.pairedChatId === "number") {
		return message.chat?.id === config.pairedChatId;
	}
	return false;
}

/** @param {Map<string, WindowState>} windows @param {number} chatId @param {number} threadId */
function findWindowByThread(windows, chatId, threadId) {
	for (const windowState of windows.values()) {
		if (windowState.boundChatId === chatId && windowState.boundThreadId === threadId) {
			return windowState;
		}
	}
	return null;
}

/** @param {Map<string, WindowState>} windows */
function getOnlyWindow(windows) {
	if (windows.size !== 1) return null;
	return [...windows.values()][0];
}

/** @param {Map<string, WindowState>} windows @param {Config} config @param {import("node-telegram-bot-api").Message} message */
function resolveWindowFromMessage(windows, config, message) {
	const chatId = message.chat?.id;
	if (typeof chatId !== "number") return null;

	if (
		typeof config.forumChatId === "number" &&
		chatId === config.forumChatId &&
		typeof message.message_thread_id === "number"
	) {
		return findWindowByThread(windows, chatId, message.message_thread_id);
	}

	if (message.chat?.type === "private") {
		return getOnlyWindow(windows);
	}

	return null;
}

/** @param {import("node-telegram-bot-api").Message} message */
function resolveProjectTopicFromMessage(message) {
	const chatId = message.chat?.id;
	if (typeof chatId !== "number") return null;
	if (typeof message.message_thread_id !== "number") return null;
	return projectTopics.get(topicKey(chatId, message.message_thread_id)) ?? null;
}

/** @param {ProjectTopic} projectTopic */
function touchProjectTopic(projectTopic) {
	const now = Date.now();
	projectTopic.updatedAt = now;
	projectTopic.lastUsedAt = now;
	void persistProjectTopics();
}

/** @param {import("node-telegram-bot-api").Message} message */
function isGroupLike(message) {
	return message.chat?.type === "group" || message.chat?.type === "supergroup";
}

/** @param {number} chatId @param {string} text @param {import("node-telegram-bot-api").SendMessageOptions} [options] @param {TelegramBot | null} bot */
async function botSend(bot, chatId, text, options = {}) {
	if (!bot) return;
	const chunks = chunkText(text);
	for (const chunk of chunks) {
		await bot.sendMessage(chatId, chunk, options);
	}
}

/** @param {number} chatId @param {string} text @param {TelegramBot | null} bot */
async function botSendSystem(bot, chatId, text) {
	if (!bot) return;
	await bot.sendMessage(chatId, `<i>${escapeHtml(text)}</i>`, { parse_mode: "HTML" });
}

/** @param {TelegramBot | null} bot @param {number} chatId @param {number} threadId @param {string} text */
async function botSendSystemThread(bot, chatId, threadId, text) {
	if (!bot) return;
	await bot.sendMessage(chatId, `<i>${escapeHtml(text)}</i>`, {
		parse_mode: "HTML",
		message_thread_id: threadId,
	});
}

/** @param {TelegramBot | null} bot @param {number} chatId @param {number} threadId @param {string} text */
async function botSendAssistantThread(bot, chatId, threadId, text) {
	if (!bot) return;

	if (text.length <= 3500) {
		try {
			await bot.sendMessage(chatId, text, {
				parse_mode: "Markdown",
				message_thread_id: threadId,
			});
			return;
		} catch {
			// Fall through to plain text.
		}
	}

	const chunks = chunkText(text);
	for (const chunk of chunks) {
		await bot.sendMessage(chatId, chunk, { message_thread_id: threadId });
	}
}

/** @param {Map<string, WindowState>} windows */
function listWindowsText(windows) {
	const list = [...windows.values()].sort((a, b) => a.windowNo - b.windowNo);
	if (list.length === 0) {
		return "No windows connected. Run /telegram pair (and /telegram) in pi.";
	}

	const lines = list.map((windowState) => {
		const bound =
			typeof windowState.boundThreadId === "number"
				? `topic ${windowState.boundThreadId}${windowState.boundTopicTitle ? ` (${windowState.boundTopicTitle})` : ""}`
				: "not bound";
		const busy = windowState.busy ? "busy" : "idle";
		const icon = windowState.topicIconState ?? "unknown";
		const percent = typeof windowState.topicIconContextPercent === "number"
			? ` (${windowState.topicIconContextPercent.toFixed(1)}%)`
			: "";
		return `${windowState.windowNo}) ${windowDisplayName(windowState)} · ${bound} · ${busy} · ${windowModelLabel(windowState)} · think ${windowThinkingLabel(windowState)} · icon ${icon}${percent}`;
	});

	return `Windows:\n${lines.join("\n")}`;
}

/** @param {Map<string, WindowState>} windows */
function getBusyBoundWindows(windows) {
	return [...windows.values()].filter(
		(windowState) =>
			windowState.busy &&
			typeof windowState.boundChatId === "number" &&
			typeof windowState.boundThreadId === "number",
	);
}

function persistManagedTopics() {
	managedTopicsSaveTask = managedTopicsSaveTask
		.then(() => saveManagedTopics(managedTopics))
		.catch((error) => {
			console.error("[telegram] Failed to persist managed topics", error);
		});
	return managedTopicsSaveTask;
}

function persistProjectProfiles() {
	projectProfilesSaveTask = projectProfilesSaveTask
		.then(() => saveProjectProfiles(projectProfiles))
		.catch((error) => {
			console.error("[telegram] Failed to persist project profiles", error);
		});
	return projectProfilesSaveTask;
}

function persistProjectTopics() {
	projectTopicsSaveTask = projectTopicsSaveTask
		.then(() => saveProjectTopics(projectTopics))
		.catch((error) => {
			console.error("[telegram] Failed to persist project topics", error);
		});
	return projectTopicsSaveTask;
}

function isStaleTopicCleanupEnabled() {
	return config.staleTopicCleanupEnabled !== false;
}

function getStaleTopicGraceMs() {
	if (typeof config.staleTopicGraceSec === "number" && Number.isFinite(config.staleTopicGraceSec)) {
		const clamped = Math.max(15, Math.min(7 * 24 * 3600, Math.floor(config.staleTopicGraceSec)));
		return clamped * 1000;
	}
	return DEFAULT_STALE_TOPIC_GRACE_SEC * 1000;
}

function isTopicBoundByAnyWindow(chatId, threadId) {
	for (const windowState of windows.values()) {
		if (windowState.boundChatId === chatId && windowState.boundThreadId === threadId) {
			return true;
		}
	}
	return false;
}

function rememberManagedTopic(chatId, threadId, title, options = {}) {
	const key = topicKey(chatId, threadId);
	const now = Date.now();
	const existing = managedTopics.get(key);
	if (existing) {
		existing.updatedAt = now;
		if (typeof title === "string" && title.trim()) {
			existing.title = title;
		}
		if (options.markBound !== false) {
			existing.lastBoundAt = now;
			existing.unboundSince = undefined;
		} else if (typeof existing.unboundSince !== "number") {
			existing.unboundSince = now;
		}
	} else {
		managedTopics.set(key, {
			chatId,
			threadId,
			title: typeof title === "string" && title.trim() ? title.trim() : undefined,
			createdAt: now,
			updatedAt: now,
			lastBoundAt: now,
			unboundSince: options.markBound === false ? now : undefined,
		});
	}
	void persistManagedTopics();
}

function forgetManagedTopic(chatId, threadId) {
	const key = topicKey(chatId, threadId);
	if (!managedTopics.delete(key)) return;
	void persistManagedTopics();
}

function markManagedTopicUnbound(chatId, threadId) {
	const key = topicKey(chatId, threadId);
	const existing = managedTopics.get(key);
	if (!existing) return;
	if (typeof existing.unboundSince === "number") return;
	const now = Date.now();
	existing.unboundSince = now;
	existing.updatedAt = now;
	void persistManagedTopics();
}

/** @param {WindowState} windowState */
function clearWindowTopicIconTimer(windowState) {
	if (windowState.topicIconPendingTimer) {
		clearTimeout(windowState.topicIconPendingTimer);
		windowState.topicIconPendingTimer = undefined;
	}
	windowState.topicIconPendingState = undefined;
	windowState.topicIconUpdateInFlight = false;
	windowState.topicIconInFlightState = undefined;
	windowState.topicIconInFlightId = undefined;
}

/** @param {WindowState} windowState */
function resetWindowTopicIconTracking(windowState) {
	clearWindowTopicIconTimer(windowState);
	windowState.topicIconLastAppliedState = undefined;
	windowState.topicIconLastAppliedId = undefined;
	windowState.topicIconLastEditAt = 0;
}

/** @param {WindowState} windowState @param {number} chatId @param {number} threadId @param {string | undefined} title */
function setWindowTopicBinding(windowState, chatId, threadId, title) {
	const bindingChanged = windowState.boundChatId !== chatId || windowState.boundThreadId !== threadId;
	windowState.boundChatId = chatId;
	windowState.boundThreadId = threadId;
	if (typeof title === "string") {
		windowState.boundTopicTitle = title;
	}
	if (bindingChanged) {
		console.info(
			`[telegram] Bound window ${windowState.windowNo} to topic ${chatId}:${threadId}`,
			windowState.boundTopicTitle ? `(${windowState.boundTopicTitle})` : "",
		);
		resetWindowTopicIconTracking(windowState);
	}
	rememberManagedTopic(chatId, threadId, windowState.boundTopicTitle, { markBound: true });
	if (windowState.topicIconState) {
		scheduleTopicIconUpdate(windowState, windowState.topicIconState, { force: true });
	}
}

function clearWindowTopicBinding(windowState) {
	const previousChatId = windowState.boundChatId;
	const previousThreadId = windowState.boundThreadId;
	windowState.boundChatId = undefined;
	windowState.boundThreadId = undefined;
	windowState.boundTopicTitle = undefined;
	resetWindowTopicIconTracking(windowState);
	if (typeof previousChatId === "number" && typeof previousThreadId === "number") {
		console.info(`[telegram] Unbound window ${windowState.windowNo} from topic ${previousChatId}:${previousThreadId}`);
		markManagedTopicUnbound(previousChatId, previousThreadId);
	}
}

function isHarmlessTopicIconEditError(error) {
	const message = String(error?.message ?? error).toLowerCase();
	return (
		message.includes("message is not modified") ||
		message.includes("topic not found") ||
		message.includes("message thread not found") ||
		message.includes("chat not found")
	);
}

/** @param {TopicIconState} state */
function getTopicIconEmojiForState(state) {
	const configured = getConfiguredTopicIconEmoji(state);
	if (typeof configured === "string" && configured.trim()) {
		return configured.trim();
	}
	return DEFAULT_TOPIC_ICON_EMOJIS[state];
}

/** @param {TopicIconState} state */
function resolveTopicIconCustomIdForState(state) {
	const configuredId = getConfiguredTopicIconCustomId(state);
	if (typeof configuredId === "string" && configuredId.trim()) {
		return configuredId.trim();
	}
	return topicIconIdByState[state];
}

function refreshTopicIconStateMapping() {
	/** @type {Partial<Record<TopicIconState, string>>} */
	const nextMap = {};
	for (const state of /** @type {TopicIconState[]} */ (["thinking", "green", "yellow", "red"])) {
		const configuredId = getConfiguredTopicIconCustomId(state);
		if (configuredId) {
			nextMap[state] = configuredId;
			continue;
		}
		const emoji = getTopicIconEmojiForState(state);
		const iconId = topicIconStickerIdByEmoji.get(emoji);
		if (iconId) {
			nextMap[state] = iconId;
		}
	}
	topicIconIdByState = nextMap;

	if (!isTopicIconEnabled()) {
		topicIconMissingWarning = "";
		return;
	}

	const missing = /** @type {TopicIconState[]} */ (["thinking", "green", "yellow", "red"]).filter(
		(state) => typeof nextMap[state] !== "string",
	);
	const warning = missing.length > 0 ? missing.join(",") : "";
	if (warning !== topicIconMissingWarning) {
		topicIconMissingWarning = warning;
		if (warning) {
			console.error(
				`[telegram] Topic icon mapping incomplete for states: ${missing.join(", ")}. Configure topicIconCustomEmojiIds/topicIconEmojis in ${CONFIG_PATH}.`,
			);
		}
	}
}

async function refreshTopicIconCatalog() {
	if (!bot) return;
	if (typeof config.forumChatId !== "number") return;
	if (!isTopicIconEnabled()) return;

	try {
		const stickers = await bot.getForumTopicIconStickers(config.forumChatId);
		topicIconStickerIdByEmoji.clear();
		for (const sticker of Array.isArray(stickers) ? stickers : []) {
			const emoji = typeof sticker?.emoji === "string" ? sticker.emoji : undefined;
			const iconId = typeof sticker?.custom_emoji_id === "string" ? sticker.custom_emoji_id : undefined;
			if (!emoji || !iconId) continue;
			if (!topicIconStickerIdByEmoji.has(emoji)) {
				topicIconStickerIdByEmoji.set(emoji, iconId);
			}
		}
		topicIconCatalogLoaded = true;
		refreshTopicIconStateMapping();
	} catch (error) {
		console.error("[telegram] Failed to load forum topic icon stickers", error);
	}
}

async function ensureTopicIconCatalogLoaded() {
	if (!isTopicIconEnabled()) return;
	refreshTopicIconStateMapping();
	if (topicIconCatalogLoaded && topicIconStickerIdByEmoji.size > 0) {
		return;
	}
	if (typeof config.forumChatId === "number") {
		await refreshTopicIconCatalog();
	}
}

/** @param {WindowState} windowState @param {TopicIconState} state @param {string} iconId */
async function applyTopicIconState(windowState, state, iconId) {
	if (!bot || !isTopicIconEnabled()) return false;
	if (typeof windowState.boundChatId !== "number" || typeof windowState.boundThreadId !== "number") return false;

	if (windowState.topicIconLastAppliedState === state && windowState.topicIconLastAppliedId === iconId) {
		return true;
	}

	const targetChatId = windowState.boundChatId;
	const targetThreadId = windowState.boundThreadId;

	try {
		await bot.editForumTopic(targetChatId, targetThreadId, {
			icon_custom_emoji_id: iconId,
		});
		if (windowState.boundChatId !== targetChatId || windowState.boundThreadId !== targetThreadId) {
			console.warn(
				`[telegram] Ignoring stale topic icon completion for ${targetChatId}:${targetThreadId}`,
				"(window binding changed)",
			);
			return false;
		}
		windowState.topicIconLastAppliedState = state;
		windowState.topicIconLastAppliedId = iconId;
		windowState.topicIconLastEditAt = Date.now();
		console.info(
			`[telegram] Topic icon updated for ${targetChatId}:${targetThreadId}`,
			`state=${state}`,
			`iconId=${iconId}`,
		);
		return true;
	} catch (error) {
		if (isHarmlessTopicIconEditError(error)) {
			if (windowState.boundChatId !== targetChatId || windowState.boundThreadId !== targetThreadId) {
				return false;
			}
			windowState.topicIconLastAppliedState = state;
			windowState.topicIconLastAppliedId = iconId;
			windowState.topicIconLastEditAt = Date.now();
			return true;
		}
		console.error(
			`[telegram] Failed to edit topic icon for ${targetChatId}:${targetThreadId}`,
			error,
		);
		return false;
	}
}

/** @param {WindowState} windowState */
async function flushTopicIconUpdate(windowState) {
	if (windowState.topicIconUpdateInFlight) return;
	if (!isTopicIconEnabled()) return;
	if (typeof windowState.boundChatId !== "number" || typeof windowState.boundThreadId !== "number") return;

	windowState.topicIconUpdateInFlight = true;
	try {
		while (true) {
			const desiredState = windowState.topicIconState;
			if (!desiredState) return;

			await ensureTopicIconCatalogLoaded();
			const iconId = resolveTopicIconCustomIdForState(desiredState);
			if (!iconId) {
				console.warn(
					`[telegram] Skipping topic icon update for ${windowState.boundChatId}:${windowState.boundThreadId}`,
					`state=${desiredState}`,
					"(no icon mapping)",
				);
				return;
			}

			if (
				windowState.topicIconLastAppliedState === desiredState &&
				windowState.topicIconLastAppliedId === iconId
			) {
				return;
			}

			windowState.topicIconInFlightState = desiredState;
			windowState.topicIconInFlightId = iconId;
			const applied = await applyTopicIconState(windowState, desiredState, iconId);

			if (windowState.topicIconState !== desiredState) {
				continue;
			}

			if (applied) {
				return;
			}

			return;
		}
	} finally {
		windowState.topicIconUpdateInFlight = false;
		windowState.topicIconInFlightState = undefined;
		windowState.topicIconInFlightId = undefined;
	}
}

/** @param {WindowState} windowState @param {TopicIconState} state @param {{ force?: boolean }} [options] */
function scheduleTopicIconUpdate(windowState, state, options = {}) {
	const previousState = windowState.topicIconState;
	windowState.topicIconState = state;
	if (!isTopicIconEnabled()) return;
	if (typeof windowState.boundChatId !== "number" || typeof windowState.boundThreadId !== "number") return;

	if (!options.force && previousState === state) {
		const knownIconId = resolveTopicIconCustomIdForState(state);
		if (
			knownIconId &&
			windowState.topicIconLastAppliedState === state &&
			windowState.topicIconLastAppliedId === knownIconId
		) {
			console.info(
				`[telegram] Topic icon deduped for ${windowState.boundChatId}:${windowState.boundThreadId}`,
				`state=${state}`,
				"(already applied)",
			);
			return;
		}
		if (
			knownIconId &&
			windowState.topicIconUpdateInFlight &&
			windowState.topicIconInFlightState === state &&
			windowState.topicIconInFlightId === knownIconId
		) {
			console.info(
				`[telegram] Topic icon deduped for ${windowState.boundChatId}:${windowState.boundThreadId}`,
				`state=${state}`,
				"(update already in flight)",
			);
			return;
		}
	}

	if (previousState !== state || options.force) {
		console.info(
			`[telegram] Topic icon request for ${windowState.boundChatId}:${windowState.boundThreadId}`,
			`from=${previousState ?? "unset"}`,
			`to=${state}`,
			typeof windowState.topicIconContextPercent === "number"
				? `context=${windowState.topicIconContextPercent.toFixed(1)}%`
				: "",
		);
	}

	void flushTopicIconUpdate(windowState);
}

function isMissingTopicError(error) {
	const message = String(error?.message ?? error).toLowerCase();
	return (
		message.includes("message thread not found") ||
		message.includes("topic not found") ||
		message.includes("chat not found")
	);
}

async function removeManagedTopicFromForum(topic, reason = "stale") {
	if (!bot) return;

	const topicLabel = topic.title?.trim() ? `${topic.title} (#${topic.threadId})` : `#${topic.threadId}`;
	let removed = false;

	try {
		await bot.deleteForumTopic(topic.chatId, topic.threadId);
		removed = true;
	} catch (error) {
		if (isMissingTopicError(error)) {
			removed = true;
		} else {
			console.error(`[telegram] Failed to delete managed topic ${topic.chatId}:${topic.threadId}`, error);
			return;
		}
	}

	if (removed) {
		console.warn(`[telegram] Removed managed topic ${topic.chatId}:${topic.threadId} (${reason})`);
		forgetManagedTopic(topic.chatId, topic.threadId);
		await botSendSystem(
			bot,
			topic.chatId,
			`🧹 Removed stale topic ${topicLabel} (${reason}; no active session).`,
		);
	}
}

async function sweepStaleManagedTopics() {
	if (!isStaleTopicCleanupEnabled()) return;
	if (staleTopicSweepRunning) {
		staleTopicSweepRequested = true;
		return;
	}

	staleTopicSweepRunning = true;
	try {
		const graceMs = getStaleTopicGraceMs();
		const now = Date.now();
		const snapshot = [...managedTopics.values()];
		let changed = false;

		for (const topic of snapshot) {
			if (
				typeof config.forumChatId === "number" &&
				topic.chatId !== config.forumChatId
			) {
				continue;
			}

			if (isTopicBoundByAnyWindow(topic.chatId, topic.threadId)) {
				if (typeof topic.unboundSince === "number") {
					topic.unboundSince = undefined;
					topic.updatedAt = now;
					changed = true;
				}
				continue;
			}

			if (typeof topic.unboundSince !== "number") {
				topic.unboundSince = now;
				topic.updatedAt = now;
				changed = true;
				continue;
			}

			if (now - topic.unboundSince < graceMs) {
				continue;
			}

			console.warn(
				`[telegram] Stale topic sweep removing ${topic.chatId}:${topic.threadId}`,
				`unboundForMs=${now - topic.unboundSince}`,
				`graceMs=${graceMs}`,
			);
			await removeManagedTopicFromForum(topic, "no active window");
		}

		if (changed) {
			void persistManagedTopics();
		}
	} finally {
		staleTopicSweepRunning = false;
		if (staleTopicSweepRequested) {
			staleTopicSweepRequested = false;
			void sweepStaleManagedTopics();
		}
	}
}

const lockAcquired = await acquireDaemonLock();
if (!lockAcquired) {
	process.exit(0);
}

process.on("exit", () => {
	releaseDaemonLock();
});

let loadedConfig = await loadConfig();
if (!loadedConfig || !loadedConfig.botToken) {
	console.error(`[telegram] Missing bot token in ${CONFIG_PATH}.`);
	releaseDaemonLock();
	process.exit(1);
}

/** @type {Config} */
const config = loadedConfig;
console.info(
	"[telegram] Config loaded",
	`forumChatId=${typeof config.forumChatId === "number" ? config.forumChatId : "unset"}`,
	`staleCleanup=${config.staleTopicCleanupEnabled !== false}`,
	`staleGraceSec=${typeof config.staleTopicGraceSec === "number" ? config.staleTopicGraceSec : DEFAULT_STALE_TOPIC_GRACE_SEC}`,
);

/** @type {TelegramBot | null} */
let bot = null;

/** @type {Map<string, WindowState>} */
const windows = new Map();
let nextWindowNo = 1;

/** @type {Map<string, string>} */
const topicIconStickerIdByEmoji = new Map();
/** @type {Partial<Record<TopicIconState, string>>} */
let topicIconIdByState = {};
let topicIconCatalogLoaded = false;
let topicIconMissingWarning = "";

/** @type {Map<string, ManagedTopic>} */
const managedTopics = new Map();
for (const topic of await loadManagedTopics()) {
	const key = topicKey(topic.chatId, topic.threadId);
	managedTopics.set(key, {
		chatId: topic.chatId,
		threadId: topic.threadId,
		title: typeof topic.title === "string" ? topic.title : undefined,
		createdAt: typeof topic.createdAt === "number" ? topic.createdAt : Date.now(),
		updatedAt: typeof topic.updatedAt === "number" ? topic.updatedAt : Date.now(),
		lastBoundAt: typeof topic.lastBoundAt === "number" ? topic.lastBoundAt : Date.now(),
		unboundSince: typeof topic.unboundSince === "number" ? topic.unboundSince : Date.now(),
	});
}

/** @type {Map<string, ProjectProfile>} */
const projectProfiles = new Map();
for (const profile of await loadProjectProfiles()) {
	projectProfiles.set(String(profile.projectKey), {
		projectKey: String(profile.projectKey),
		projectName: String(profile.projectName),
		cwd: String(profile.cwd),
		storageDir: String(profile.storageDir),
		sessionDir: String(profile.sessionDir),
		createdAt: typeof profile.createdAt === "number" ? profile.createdAt : Date.now(),
		updatedAt: typeof profile.updatedAt === "number" ? profile.updatedAt : Date.now(),
	});
}

/** @type {Map<string, ProjectTopic>} */
const projectTopics = new Map();
for (const topic of await loadProjectTopics()) {
	const key = topicKey(topic.chatId, topic.threadId);
	projectTopics.set(key, {
		chatId: topic.chatId,
		threadId: topic.threadId,
		title: typeof topic.title === "string" ? topic.title : undefined,
		projectKey: String(topic.projectKey),
		projectName: String(topic.projectName),
		mode: topic.mode === "setup" ? "setup" : "active",
		setupStep:
			topic.mode === "setup"
				? (topic.setupStep === "awaiting_storage" ? "awaiting_storage" : "awaiting_cwd")
				: undefined,
		cwd: typeof topic.cwd === "string" ? topic.cwd : undefined,
		storageDir: typeof topic.storageDir === "string" ? topic.storageDir : undefined,
		sessionDir: typeof topic.sessionDir === "string" ? topic.sessionDir : undefined,
		sessionFile: typeof topic.sessionFile === "string" ? topic.sessionFile : undefined,
		createdAt: typeof topic.createdAt === "number" ? topic.createdAt : Date.now(),
		updatedAt: typeof topic.updatedAt === "number" ? topic.updatedAt : Date.now(),
		lastUsedAt: typeof topic.lastUsedAt === "number" ? topic.lastUsedAt : Date.now(),
	});
}

/** @type {Map<string, ProjectWorker>} */
const projectWorkers = new Map();

/** @type {Map<string, { windowId: string; expiresAt: number }>} */
const pendingPins = new Map();

/** @type {NodeJS.Timeout | null} */
let shutdownTimer = null;
/** @type {NodeJS.Timeout | null} */
let typingTimer = null;
/** @type {NodeJS.Timeout | null} */
let pinCleanupTimer = null;
/** @type {NodeJS.Timeout | null} */
let staleTopicSweepIntervalTimer = null;
let staleTopicSweepRunning = false;
let staleTopicSweepRequested = false;
let managedTopicsSaveTask = Promise.resolve();
let projectProfilesSaveTask = Promise.resolve();
let projectTopicsSaveTask = Promise.resolve();
let ownedSocketInode = null;
let isShuttingDown = false;

async function sendTypingForBusyWindows() {
	if (!bot) return;
	const busyBound = getBusyBoundWindows(windows);
	for (const windowState of busyBound) {
		if (typeof windowState.boundChatId !== "number" || typeof windowState.boundThreadId !== "number") continue;
		try {
			await bot.sendChatAction(windowState.boundChatId, "typing", {
				message_thread_id: windowState.boundThreadId,
			});
		} catch {
			// Ignore sendChatAction failures.
		}
	}
}

function stopTypingIndicator() {
	if (!typingTimer) return;
	clearInterval(typingTimer);
	typingTimer = null;
}

function refreshTypingIndicator() {
	const hasBusyBound = getBusyBoundWindows(windows).length > 0;
	if (!hasBusyBound) {
		stopTypingIndicator();
		return;
	}

	if (typingTimer) return;

	void sendTypingForBusyWindows();
	typingTimer = setInterval(() => {
		void sendTypingForBusyWindows();
	}, 4000);
}

async function clearOwnerPairing() {
	delete config.ownerUserId;
	delete config.ownerDmChatId;
	delete config.pairedChatId;
	await saveConfig(config);
}

/** @param {import("node-telegram-bot-api").Message} message */
function getVoiceFileId(message) {
	if (message.voice?.file_id) return message.voice.file_id;
	if (message.audio?.file_id) return message.audio.file_id;
	return null;
}

/** @param {import("node-telegram-bot-api").Message} message @param {string} text */
async function sendContextSystemMessage(message, text) {
	const chatId = message.chat?.id;
	if (typeof chatId !== "number") return;

	if (typeof message.message_thread_id === "number") {
		await botSendSystemThread(bot, chatId, message.message_thread_id, text);
		return;
	}

	await botSendSystem(bot, chatId, text);
}

/** @param {import("node-telegram-bot-api").Message} message @param {string} emoji */
async function setMessageEmojiReaction(message, emoji) {
	if (!bot) return;
	const chatId = message.chat?.id;
	const messageId = message.message_id;
	if (typeof chatId !== "number" || typeof messageId !== "number") return;

	try {
		await bot.setMessageReaction(chatId, messageId, {
			reaction: [{ type: "emoji", emoji }],
			is_big: false,
		});
	} catch {
		// Ignore reaction failures (permissions/unsupported message types).
	}
}

/** @param {string} errorText */
function detectVoiceSetupIssue(errorText) {
	const lower = String(errorText).toLowerCase();
	if (!lower) return null;
	if (lower.includes("voicetranscribecommand is not configured")) return "command";
	if (lower.includes("no such file or directory") && lower.includes("transcribe")) return "command";
	if (lower.includes("whisper binary not found") || lower.includes("set whisper_bin") || lower.includes("build whisper.cpp")) {
		return "binary";
	}
	if (lower.includes("whisper model not found") || lower.includes("set whisper_model") || lower.includes("download model")) {
		return "model";
	}
	if (lower.includes("ffmpeg is required")) return "ffmpeg";
	return null;
}

/** @param {import("node-telegram-bot-api").Message} message @param {WindowState} targetWindow @param {string} fileId */
async function handleVoiceMemo(message, targetWindow, fileId) {
	const chatId = message.chat?.id;
	if (typeof chatId !== "number") return;

	let tempDir = "";
	try {
		await setMessageEmojiReaction(message, "⏳");

		const latestConfig = await loadConfig();
		if (latestConfig) {
			Object.assign(config, latestConfig);
		}

		if (!bot) throw new Error("Bot is not ready");
		tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "pi-telegram-voice-"));
		const downloadedPath = await bot.downloadFile(fileId, tempDir);

		const transcript = await transcribeVoiceMemo(config, downloadedPath, {
			chatId,
			threadId: typeof message.message_thread_id === "number" ? message.message_thread_id : undefined,
		});

		await sendContextSystemMessage(message, `🗣️ ${shortText(transcript, 600)}`);
		await startTurnStatus(targetWindow, message, "Processing transcribed voice memo…");

		makeJsonlWriter(targetWindow.socket)({
			type: "inject",
			mode: "followUp",
			text: transcript,
		});
	} catch (error) {
		const errorText = String(error?.message ?? error);
		const setupIssue = detectVoiceSetupIssue(errorText);
		if (setupIssue) {
			makeJsonlWriter(targetWindow.socket)({
				type: "voice_setup_required",
				issue: setupIssue,
				detail: shortText(errorText, 280),
			});
		}
		const setupHint = setupIssue ? " In pi, run /telegram voice-install to complete setup." : "";
		await sendContextSystemMessage(
			message,
			`⚠️ Voice transcription failed: ${shortText(errorText, 220)}${setupHint}`,
		);
	} finally {
		if (tempDir) {
			await fsp.rm(tempDir, { recursive: true, force: true });
		}
	}
}

function projectCommandUsage() {
	return [
		"Usage:",
		"/project new <project_name> - create a Telegram-only project topic",
		"/project join <project_name> - planned for phase 2",
	].join("\n");
}

async function replyInMessageContext(message, text) {
	const chatId = message.chat?.id;
	if (typeof chatId !== "number") return;
	if (typeof message.message_thread_id === "number") {
		await botSend(bot, chatId, text, { message_thread_id: message.message_thread_id });
		return;
	}
	await botSend(bot, chatId, text);
}

async function handleProjectNewCommand(message, rawProjectName) {
	const chatId = message.chat?.id;
	if (typeof chatId !== "number") return;

	if (typeof config.forumChatId !== "number") {
		await replyInMessageContext(message, "Forum group not set. Run /setforum first.");
		return;
	}

	if (chatId !== config.forumChatId) {
		await replyInMessageContext(message, "Run /project new inside your configured forum supergroup.");
		return;
	}

	const projectName = normalizeProjectName(rawProjectName);
	if (!projectName) {
		await replyInMessageContext(message, projectCommandUsage());
		return;
	}

	if (!bot) throw new Error("Bot not ready");

	const title = sanitizeProjectTopicTitle(projectName);
	const topic = await bot.createForumTopic(chatId, title);
	const threadId = topic.message_thread_id;
	const key = topicKey(chatId, threadId);
	const projectKey = projectNameToKey(projectName);
	const existing = projectProfiles.get(projectKey);
	const now = Date.now();

	/** @type {ProjectTopic} */
	const projectTopic = {
		chatId,
		threadId,
		title: typeof topic.name === "string" && topic.name.trim() ? topic.name.trim() : title,
		projectKey,
		projectName,
		mode: "setup",
		setupStep: "awaiting_cwd",
		createdAt: now,
		updatedAt: now,
		lastUsedAt: now,
	};
	projectTopics.set(key, projectTopic);
	void persistProjectTopics();

	const suggestedStorage = existing?.storageDir || defaultProjectStorageDir(projectName);
	const cwdHint = existing?.cwd
		? `Suggested (from previous setup): ${existing.cwd}`
		: "Example: /home/cam/dev/my-project";

	await botSendSystemThread(
		bot,
		chatId,
		threadId,
		[
			`🧩 Project setup started for \"${projectName}\".`,
			"Step 1/2: Send the project root path (cwd).",
			cwdHint,
			"Send /cancel to abort setup.",
		].join("\n"),
	);
	await replyInMessageContext(
		message,
		`Created project topic \"${projectTopic.title}\" (#${threadId}). Continue setup in that topic.`,
	);
	await botSendSystemThread(
		bot,
		chatId,
		threadId,
		`Next step hint: storage path can be ${suggestedStorage}`,
	);
}

async function handleProjectCommand(message, command) {
	const subcommand = String(command?.subcommand ?? "").trim().toLowerCase();
	const rest = String(command?.rest ?? "").trim();

	if (subcommand === "new") {
		await handleProjectNewCommand(message, rest);
		return;
	}

	if (subcommand === "join") {
		await replyInMessageContext(message, "`/project join` is planned for phase 2. Use `/project new <name>` for now.");
		return;
	}

	await replyInMessageContext(message, projectCommandUsage());
}

async function handleProjectTopicSetupInput(projectTopic, message, text) {
	if (!bot) return;
	const chatId = message.chat?.id;
	if (typeof chatId !== "number") return;
	const key = topicKey(projectTopic.chatId, projectTopic.threadId);

	if (text.startsWith("/")) {
		if (/^\/cancel(?:\s|$)/i.test(text)) {
			projectTopics.delete(key);
			void persistProjectTopics();
			try {
				await bot.deleteForumTopic(projectTopic.chatId, projectTopic.threadId);
			} catch {
				// Ignore cleanup failures.
			}
			await replyInMessageContext(message, `Cancelled setup for \"${projectTopic.projectName}\".`);
			return;
		}
		await botSendSystemThread(
			bot,
			projectTopic.chatId,
			projectTopic.threadId,
			"Setup expects a plain path value. Send /cancel to abort.",
		);
		return;
	}

	if (projectTopic.setupStep === "awaiting_cwd") {
		const cwd = resolveUserPathInput(text);
		if (!cwd) {
			await botSendSystemThread(bot, projectTopic.chatId, projectTopic.threadId, "Please send a valid project path.");
			return;
		}
		projectTopic.cwd = cwd;
		projectTopic.setupStep = "awaiting_storage";
		touchProjectTopic(projectTopic);
		const existing = projectProfiles.get(projectTopic.projectKey);
		const suggestedStorage = existing?.storageDir || defaultProjectStorageDir(projectTopic.projectName);
		await botSendSystemThread(
			bot,
			projectTopic.chatId,
			projectTopic.threadId,
			[
				"Step 2/2: Send the storage directory for personal notes/todos/research.",
				`Suggested: ${suggestedStorage}`,
			].join("\n"),
		);
		return;
	}

	if (projectTopic.setupStep === "awaiting_storage") {
		const storageDir = resolveUserPathInput(text);
		if (!storageDir) {
			await botSendSystemThread(bot, projectTopic.chatId, projectTopic.threadId, "Please send a valid storage path.");
			return;
		}
		const cwd = projectTopic.cwd || resolveUserPathInput(".") || os.homedir();
		const sessionDir = defaultProjectSessionDir(projectTopic.projectName, storageDir);
		const now = Date.now();

		await fsp.mkdir(cwd, { recursive: true, mode: 0o700 });
		await fsp.mkdir(storageDir, { recursive: true, mode: 0o700 });
		await fsp.mkdir(sessionDir, { recursive: true, mode: 0o700 });

		projectTopic.storageDir = storageDir;
		projectTopic.sessionDir = sessionDir;
		projectTopic.mode = "active";
		projectTopic.setupStep = undefined;
		projectTopic.updatedAt = now;
		projectTopic.lastUsedAt = now;

		const existing = projectProfiles.get(projectTopic.projectKey);
		projectProfiles.set(projectTopic.projectKey, {
			projectKey: projectTopic.projectKey,
			projectName: projectTopic.projectName,
			cwd,
			storageDir,
			sessionDir,
			createdAt: existing?.createdAt ?? now,
			updatedAt: now,
		});
		void persistProjectProfiles();
		void persistProjectTopics();

		await botSendSystemThread(
			bot,
			projectTopic.chatId,
			projectTopic.threadId,
			"✅ Setup complete. Starting a fresh project session…",
		);

		try {
			const worker = await ensureProjectWorker(projectTopic);
			await sendProjectWorkerCommand(worker, { type: "new_session" }, 15_000);
			const state = await sendProjectWorkerCommand(worker, { type: "get_state" }, 15_000);
			if (state && typeof state.sessionFile === "string" && state.sessionFile.trim()) {
				projectTopic.sessionFile = state.sessionFile.trim();
				touchProjectTopic(projectTopic);
			}
			await botSendSystemThread(
				bot,
				projectTopic.chatId,
				projectTopic.threadId,
				[
					`Ready. Project: ${projectTopic.projectName}`,
					`cwd: ${cwd}`,
					`storage: ${storageDir}`,
					"Send plain text to chat with pi in this topic.",
				].join("\n"),
			);
			cancelShutdown();
		} catch (error) {
			await botSendSystemThread(
				bot,
				projectTopic.chatId,
				projectTopic.threadId,
				`⚠️ Setup finished, but failed to start RPC worker: ${shortText(String(error), 220)}`,
			);
		}
		return;
	}

	await botSendSystemThread(bot, projectTopic.chatId, projectTopic.threadId, "Unexpected setup state. Run /project new again.");
}

function rejectProjectWorkerPending(worker, reason) {
	const pending = [...worker.pendingResponses.values()];
	worker.pendingResponses.clear();
	for (const entry of pending) {
		clearTimeout(entry.timer);
		entry.reject(new Error(reason));
	}
}

function handleProjectWorkerLine(worker, line) {
	const message = safeJsonParse(line);
	if (!message || typeof message.type !== "string") return;

	if (message.type === "response" && typeof message.id === "string") {
		const pending = worker.pendingResponses.get(message.id);
		if (!pending) return;
		worker.pendingResponses.delete(message.id);
		clearTimeout(pending.timer);
		if (message.success === false) {
			pending.reject(new Error(typeof message.error === "string" ? message.error : `RPC ${pending.commandType} failed`));
			return;
		}
		pending.resolve(message.data);
		return;
	}

	if (message.type === "agent_start") {
		worker.streaming = true;
		return;
	}

	if (message.type === "agent_end") {
		worker.streaming = false;
		return;
	}

	if (message.type === "turn_end") {
		const assistantText = extractAssistantTextFromRpcMessage(message.message);
		if (!assistantText) return;
		void botSendAssistantThread(bot, worker.chatId, worker.threadId, assistantText).catch((error) => {
			console.error("[telegram] Failed to deliver detached project response", error);
		});
		const topic = projectTopics.get(worker.key);
		if (topic) touchProjectTopic(topic);
		return;
	}

	if (message.type === "extension_ui_request") {
		const method = typeof message.method === "string" ? message.method : "";
		if (["select", "confirm", "input", "editor"].includes(method) && typeof message.id === "string") {
			try {
				worker.child.stdin.write(`${JSON.stringify({ type: "extension_ui_response", id: message.id, cancelled: true })}\n`);
			} catch {
				// Ignore response failures.
			}
		}
	}
}

function handleProjectWorkerStdout(worker, chunk) {
	worker.stdoutBuffer += chunk;
	while (true) {
		const newlineIndex = worker.stdoutBuffer.indexOf("\n");
		if (newlineIndex === -1) break;
		const line = worker.stdoutBuffer.slice(0, newlineIndex).trim();
		worker.stdoutBuffer = worker.stdoutBuffer.slice(newlineIndex + 1);
		if (!line) continue;
		handleProjectWorkerLine(worker, line);
	}
}

async function sendProjectWorkerCommand(worker, payload, timeoutMs = PROJECT_RPC_RESPONSE_TIMEOUT_MS) {
	if (worker.closing) {
		throw new Error(`RPC worker for ${worker.projectName} is closing`);
	}
	if (worker.child.exitCode !== null || worker.child.killed) {
		throw new Error(`RPC worker for ${worker.projectName} is not running`);
	}
	const id = `req_${++worker.nextRequestId}`;
	const message = { ...payload, id };
	return await new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			worker.pendingResponses.delete(id);
			reject(new Error(`RPC ${payload.type} timed out after ${timeoutMs}ms`));
		}, timeoutMs);

		worker.pendingResponses.set(id, {
			resolve,
			reject,
			timer,
			commandType: typeof payload.type === "string" ? payload.type : "unknown",
		});

		try {
			worker.child.stdin.write(`${JSON.stringify(message)}\n`);
		} catch (error) {
			clearTimeout(timer);
			worker.pendingResponses.delete(id);
			reject(new Error(`Failed to write RPC command: ${String(error?.message ?? error)}`));
		}
	});
}

async function stopProjectWorker(worker, reason = "shutdown") {
	if (worker.closing) return;
	worker.closing = true;
	rejectProjectWorkerPending(worker, `RPC worker stopped (${reason})`);

	if (worker.child.exitCode === null && !worker.child.killed) {
		try {
			worker.child.stdin.end();
		} catch {
			// Ignore close failures.
		}
		try {
			worker.child.kill("SIGTERM");
		} catch {
			// Ignore kill failures.
		}
		setTimeout(() => {
			if (worker.child.exitCode === null && !worker.child.killed) {
				try {
					worker.child.kill("SIGKILL");
				} catch {
					// Ignore kill failures.
				}
			}
		}, 1000);
	}

	projectWorkers.delete(worker.key);
}

async function stopAllProjectWorkers(reason = "shutdown") {
	for (const worker of [...projectWorkers.values()]) {
		await stopProjectWorker(worker, reason);
	}
}

async function ensureProjectWorker(projectTopic) {
	const key = topicKey(projectTopic.chatId, projectTopic.threadId);
	const existing = projectWorkers.get(key);
	if (existing && !existing.closing && existing.child.exitCode === null && !existing.child.killed) {
		return existing;
	}

	const cwd = (projectTopic.cwd && projectTopic.cwd.trim()) || os.homedir();
	const sessionDir = (projectTopic.sessionDir && projectTopic.sessionDir.trim())
		|| defaultProjectSessionDir(projectTopic.projectName, projectTopic.storageDir);
	const args = [
		"--mode",
		"rpc",
		"--no-extensions",
		"--no-skills",
		"--no-prompt-templates",
		"--no-themes",
	];
	const sessionFileCandidate = typeof projectTopic.sessionFile === "string"
		? projectTopic.sessionFile.trim()
		: "";
	if (sessionFileCandidate && fs.existsSync(sessionFileCandidate)) {
		args.push("--session", sessionFileCandidate);
	} else {
		projectTopic.sessionFile = undefined;
		args.push("--session-dir", sessionDir);
	}

	const child = spawn("pi", args, {
		cwd,
		env: { ...process.env },
		stdio: ["pipe", "pipe", "pipe"],
	});

	child.stdout.setEncoding("utf8");
	child.stderr.setEncoding("utf8");

	/** @type {ProjectWorker} */
	const worker = {
		id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
		key,
		chatId: projectTopic.chatId,
		threadId: projectTopic.threadId,
		projectKey: projectTopic.projectKey,
		projectName: projectTopic.projectName,
		cwd,
		sessionDir,
		sessionFile: projectTopic.sessionFile,
		child,
		pendingResponses: new Map(),
		nextRequestId: 0,
		stdoutBuffer: "",
		stderrTail: "",
		streaming: false,
		closing: false,
		startedAt: Date.now(),
	};
	projectWorkers.set(key, worker);
	cancelShutdown();

	child.stdout.on("data", (chunk) => {
		handleProjectWorkerStdout(worker, String(chunk));
	});
	child.stderr.on("data", (chunk) => {
		worker.stderrTail = shortText(`${worker.stderrTail}${String(chunk)}`, 600);
	});
	child.on("error", (error) => {
		console.error(`[telegram] Project RPC worker error for ${projectTopic.projectName}`, error);
	});
	child.on("exit", (code, signal) => {
		rejectProjectWorkerPending(worker, `RPC worker exited (code=${code ?? "null"}, signal=${signal ?? "null"})`);
		projectWorkers.delete(key);
		if (!isShuttingDown) {
			console.warn(
				`[telegram] Project RPC worker exited for ${projectTopic.projectName}`,
				`code=${code ?? "null"}`,
				`signal=${signal ?? "null"}`,
			);
		}
	});

	try {
		const state = await sendProjectWorkerCommand(worker, { type: "get_state" }, 15_000);
		if (state && typeof state.sessionFile === "string" && state.sessionFile.trim()) {
			projectTopic.sessionFile = state.sessionFile.trim();
			projectTopic.sessionDir = sessionDir;
			touchProjectTopic(projectTopic);
		}
	} catch (error) {
		await stopProjectWorker(worker, "startup_failed");
		const detail = worker.stderrTail ? `${String(error)} (${worker.stderrTail})` : String(error);
		throw new Error(detail);
	}

	return worker;
}

async function sendProjectPrompt(projectTopic, promptText, options = {}) {
	const text = String(promptText ?? "").trim();
	if (!text) return;
	const worker = await ensureProjectWorker(projectTopic);
	const mode = options.mode === "steer" ? "steer" : "default";
	const commandType = mode === "steer"
		? (worker.streaming ? "steer" : "prompt")
		: (worker.streaming ? "follow_up" : "prompt");

	const optimisticStreaming = commandType === "prompt";
	if (optimisticStreaming) {
		worker.streaming = true;
	}

	try {
		await sendProjectWorkerCommand(worker, { type: commandType, message: text });
		touchProjectTopic(projectTopic);
	} catch (error) {
		if (optimisticStreaming) {
			worker.streaming = false;
		}
		throw error;
	}
}

async function resetProjectSession(projectTopic) {
	const worker = await ensureProjectWorker(projectTopic);
	if (worker.streaming) {
		try {
			await sendProjectWorkerCommand(worker, { type: "abort" }, 10_000);
		} catch {
			// Ignore abort race errors.
		}
	}
	const result = await sendProjectWorkerCommand(worker, { type: "new_session" }, 20_000);
	if (result && typeof result.cancelled === "boolean" && result.cancelled) {
		throw new Error("New session was cancelled");
	}
	const state = await sendProjectWorkerCommand(worker, { type: "get_state" }, 15_000);
	if (state && typeof state.sessionFile === "string" && state.sessionFile.trim()) {
		projectTopic.sessionFile = state.sessionFile.trim();
		touchProjectTopic(projectTopic);
	}
}

async function abortProjectSession(projectTopic) {
	const worker = await ensureProjectWorker(projectTopic);
	await sendProjectWorkerCommand(worker, { type: "abort" }, 10_000);
}

/** @param {import("node-telegram-bot-api").Message} message */
async function handleTelegramMessage(message) {
	const chatId = message.chat?.id;
	if (typeof chatId !== "number") return;

	const text = (message.text ?? "").trim();
	const voiceFileId = getVoiceFileId(message);
	const hasText = text.length > 0;
	const hasVoice = typeof voiceFileId === "string";
	if (!hasText && !hasVoice) return;

	const pinMatch = hasText ? text.match(/^\/pin\s+(\d{6})\s*$/) : null;
	if (pinMatch) {
		const pinCode = pinMatch[1];
		const pending = pendingPins.get(pinCode);
		if (!pending) {
			await botSend(bot, chatId, "Invalid or expired PIN. Run /telegram pair in pi to generate a new one.");
			return;
		}

		if (Date.now() > pending.expiresAt) {
			pendingPins.delete(pinCode);
			await botSend(bot, chatId, "PIN expired. Run /telegram pair in pi to generate a new one.");
			return;
		}

		const requesterId = message.from?.id;
		if (typeof config.ownerUserId === "number" && requesterId !== config.ownerUserId) {
			await botSend(bot, chatId, "This bot is already paired with another Telegram account.");
			return;
		}

		if (typeof requesterId === "number") {
			config.ownerUserId = requesterId;
		}
		if (message.chat?.type === "private") {
			config.ownerDmChatId = chatId;
		}
		delete config.pairedChatId;
		await saveConfig(config);
		pendingPins.delete(pinCode);

		await botSend(
			bot,
			chatId,
			[
				"Paired successfully.",
				"Next steps:",
				"1) Add this bot to your forum supergroup",
				"2) Give it admin rights with Manage Topics",
				"3) In that supergroup run /setforum",
				"4) In pi run /telegram to create a topic per session",
			].join("\n"),
		);
		return;
	}

	if (!isAuthorizedMessage(config, message)) {
		if (hasText && text.startsWith("/")) {
			await botSend(bot, chatId, "Not authorized. Pair first using /pin from your owner account.");
		}
		return;
	}

	if (text === "/help") {
		await botSend(
			bot,
			chatId,
			[
				"Telegram bridge commands:",
				"/setforum - set this supergroup as forum home",
				"/forumstatus - show paired owner + forum group",
				"/windows - list connected pi windows and topic bindings",
				"/project new <name> - create Telegram-only project topic",
				"/new - start a fresh session in this topic",
				"/steer <message> - interrupt current topic session",
				"/esc - abort current topic session",
				"/reload - reconnect bridge for current topic window",
				"/unpair - clear owner pairing",
				"plain text in a bound topic - send follow-up to that session",
				"voice memo in a bound topic - transcribe + send follow-up",
			].join("\n"),
		);
		return;
	}

	if (text === "/setforum") {
		if (!isGroupLike(message)) {
			await botSend(bot, chatId, "Run /setforum inside your forum supergroup.");
			return;
		}

		config.forumChatId = chatId;
		await saveConfig(config);
		await refreshTopicIconCatalog();
		await botSend(bot, chatId, "Forum home set. Now run /telegram in a pi session to create a topic.");
		return;
	}

	if (text === "/forumstatus") {
		const owner = typeof config.ownerUserId === "number" ? `set (${config.ownerUserId})` : "not set";
		const forum = typeof config.forumChatId === "number" ? `set (${config.forumChatId})` : "not set";
		await botSend(bot, chatId, `Owner: ${owner}\nForum group: ${forum}`);
		return;
	}

	if (text === "/windows") {
		await botSend(bot, chatId, listWindowsText(windows));
		return;
	}

	if (text === "/unpair") {
		await clearOwnerPairing();
		await botSend(bot, chatId, "Owner pairing cleared.");
		return;
	}

	const projectCommand = hasText ? parseProjectCommand(text) : null;
	if (projectCommand) {
		await handleProjectCommand(message, projectCommand);
		return;
	}

	const targetWindow = resolveWindowFromMessage(windows, config, message);
	const targetProjectTopic = resolveProjectTopicFromMessage(message);

	if (hasText && targetProjectTopic?.mode === "setup") {
		await handleProjectTopicSetupInput(targetProjectTopic, message, text);
		return;
	}

	if (hasVoice) {
		if (targetWindow) {
			await handleVoiceMemo(message, targetWindow, voiceFileId);
			return;
		}
		if (targetProjectTopic?.mode === "setup") {
			await botSendSystemThread(
				bot,
				targetProjectTopic.chatId,
				targetProjectTopic.threadId,
				"Project setup expects text path inputs. Send text for now.",
			);
			return;
		}
		if (targetProjectTopic?.mode === "active") {
			await botSendSystemThread(
				bot,
				targetProjectTopic.chatId,
				targetProjectTopic.threadId,
				"Voice memo routing for /project topics is coming soon. Send text for now.",
			);
			return;
		}
		if (message.chat?.type === "private") {
			await botSend(
				bot,
				chatId,
				"No topic context selected. Send voice memo inside a session topic in your forum supergroup.",
			);
		}
		return;
	}

	if (text === "/new") {
		if (targetWindow) {
			await startTurnStatus(targetWindow, message, "Starting a new session…");
			makeJsonlWriter(targetWindow.socket)({ type: "session_new" });
			return;
		}
		if (targetProjectTopic?.mode === "active") {
			try {
				await resetProjectSession(targetProjectTopic);
				await botSendSystemThread(bot, targetProjectTopic.chatId, targetProjectTopic.threadId, "Started a fresh project session.");
			} catch (error) {
				await botSendSystemThread(
					bot,
					targetProjectTopic.chatId,
					targetProjectTopic.threadId,
					`⚠️ Failed to start a new session: ${shortText(String(error), 220)}`,
				);
			}
			return;
		}
		await botSend(bot, chatId, "No bound window for this chat/topic.");
		return;
	}

	if (text === "/esc") {
		if (targetWindow) {
			scheduleTurnStatusUpdate(targetWindow, "Abort requested…", { force: true });
			makeJsonlWriter(targetWindow.socket)({ type: "abort" });
			return;
		}
		if (targetProjectTopic?.mode === "active") {
			try {
				await abortProjectSession(targetProjectTopic);
				await botSendSystemThread(bot, targetProjectTopic.chatId, targetProjectTopic.threadId, "Abort requested.");
			} catch (error) {
				await botSendSystemThread(
					bot,
					targetProjectTopic.chatId,
					targetProjectTopic.threadId,
					`⚠️ Failed to abort: ${shortText(String(error), 220)}`,
				);
			}
			return;
		}
		await botSend(bot, chatId, "No bound window for this chat/topic.");
		return;
	}

	if (text === "/reload") {
		if (targetWindow) {
			makeJsonlWriter(targetWindow.socket)({ type: "reload" });
			await sendContextSystemMessage(message, "Requested bridge reload for this topic.");
			return;
		}
		if (targetProjectTopic?.mode === "active") {
			await botSendSystemThread(
				bot,
				targetProjectTopic.chatId,
				targetProjectTopic.threadId,
				"Detached /project topics reconnect automatically. No reload needed.",
			);
			return;
		}
		await botSend(bot, chatId, "No bound window for this chat/topic.");
		return;
	}

	const steerMatch = text.match(/^\/steer\s+([\s\S]+)$/);
	if (steerMatch) {
		const steerText = steerMatch[1].trim();
		if (!steerText) {
			await botSend(bot, chatId, "Usage: /steer <message>");
			return;
		}
		if (targetWindow) {
			await startTurnStatus(targetWindow, message, "Applying steering instructions…");
			makeJsonlWriter(targetWindow.socket)({ type: "inject", mode: "steer", text: steerText });
			return;
		}
		if (targetProjectTopic?.mode === "active") {
			try {
				await sendProjectPrompt(targetProjectTopic, steerText, { mode: "steer" });
			} catch (error) {
				await botSendSystemThread(
					bot,
					targetProjectTopic.chatId,
					targetProjectTopic.threadId,
					`⚠️ Failed to send steering message: ${shortText(String(error), 220)}`,
				);
			}
			return;
		}
		await botSend(bot, chatId, "No bound window for this chat/topic.");
		return;
	}

	if (text.startsWith("/")) {
		await botSend(bot, chatId, "Unknown command. Use /help.");
		return;
	}

	if (targetWindow) {
		await startTurnStatus(targetWindow, message, "Processing request…");
		makeJsonlWriter(targetWindow.socket)({ type: "inject", mode: "followUp", text });
		return;
	}

	if (targetProjectTopic?.mode === "active") {
		try {
			await sendProjectPrompt(targetProjectTopic, text);
		} catch (error) {
			await botSendSystemThread(
				bot,
				targetProjectTopic.chatId,
				targetProjectTopic.threadId,
				`⚠️ Failed to send message to project session: ${shortText(String(error), 220)}`,
			);
		}
		return;
	}

	if (message.chat?.type === "private") {
		await botSend(
			bot,
			chatId,
			"No topic context selected. Send messages inside a session topic in your forum supergroup.",
		);
	}
}

/** @param {net.Server} server */
async function maybeShutdownSoon(server) {
	if (windows.size > 0) return;
	if (projectWorkers.size > 0) return;
	if (projectTopics.size > 0) return;
	if (typeof config.ownerUserId === "number" && typeof config.forumChatId === "number") {
		// Keep daemon alive for Telegram-only project topics even when no pi window is attached.
		return;
	}
	if (shutdownTimer) return;

	shutdownTimer = setTimeout(async () => {
		shutdownTimer = null;
		if (windows.size > 0 || projectWorkers.size > 0 || projectTopics.size > 0) return;
		if (typeof config.ownerUserId === "number" && typeof config.forumChatId === "number") return;

		console.error("[telegram] No windows or detached project topics connected, shutting down daemon.");
		await cleanup(server);
		process.exit(0);
	}, 60_000);
}

function cancelShutdown() {
	if (!shutdownTimer) return;
	clearTimeout(shutdownTimer);
	shutdownTimer = null;
}

function unlinkSocketFile(options = {}) {
	try {
		if (!fs.existsSync(SOCKET_PATH)) return;

		if (!options.force && typeof ownedSocketInode === "number") {
			const stat = fs.statSync(SOCKET_PATH);
			if (stat.ino !== ownedSocketInode) {
				return;
			}
		}

		fs.unlinkSync(SOCKET_PATH);
	} catch {
		// Ignore unlink failures.
	}
}

/** @param {net.Server} server */
async function cleanup(server) {
	unlinkSocketFile();

	if (pinCleanupTimer) {
		clearInterval(pinCleanupTimer);
		pinCleanupTimer = null;
	}
	if (staleTopicSweepIntervalTimer) {
		clearInterval(staleTopicSweepIntervalTimer);
		staleTopicSweepIntervalTimer = null;
	}
	stopTypingIndicator();

	for (const windowState of windows.values()) {
		if (windowState.activeStatus) {
			await deleteTurnStatus(windowState);
		}
		clearWindowTopicIconTimer(windowState);
	}

	await stopAllProjectWorkers("cleanup");

	try {
		if (bot) {
			await Promise.race([
				bot.stopPolling().catch(() => undefined),
				new Promise((resolve) => setTimeout(resolve, 5000)),
			]);
		}
	} catch {
		// Ignore polling stop failures.
	}
	try {
		await new Promise((resolve) => server.close(() => resolve(undefined)));
	} catch {
		// Ignore server close failures.
	}
	unlinkSocketFile();
}

async function startServer() {
	await fsp.mkdir(RUN_DIR, { recursive: true, mode: 0o700 });

	if (fs.existsSync(SOCKET_PATH)) {
		const active = await new Promise((resolve) => {
			const socket = net.connect(SOCKET_PATH);

			const done = (running) => {
				socket.removeAllListeners();
				try {
					socket.end();
				} catch {
					// ignore
				}
				try {
					socket.destroy();
				} catch {
					// ignore
				}
				resolve(running);
			};

			socket.once("connect", () => done(true));
			socket.once("error", () => done(false));
		});

		if (active) {
			console.error("[telegram] Daemon already running.");
			releaseDaemonLock();
			process.exit(0);
		}

		try {
			fs.unlinkSync(SOCKET_PATH);
		} catch {
			// Ignore stale socket cleanup failures.
		}
	}

	const server = net.createServer((socket) => {
		cancelShutdown();

		socket.setEncoding("utf8");
		const send = makeJsonlWriter(socket);
		let buffer = "";
		/** @type {string | undefined} */
		let windowId;

		socket.on("data", (data) => {
			buffer += data;
			while (true) {
				const newlineIndex = buffer.indexOf("\n");
				if (newlineIndex === -1) break;

				const line = buffer.slice(0, newlineIndex).trim();
				buffer = buffer.slice(newlineIndex + 1);
				if (!line) continue;

				const message = safeJsonParse(line);
				if (!message || typeof message.type !== "string") continue;

				switch (message.type) {
					case "register": {
						windowId =
							typeof message.windowId === "string" && message.windowId
								? message.windowId
								: `${Date.now()}-${Math.random().toString(16).slice(2)}`;

						const existing = windows.get(windowId);
						if (existing?.activeStatus) {
							void deleteTurnStatus(existing);
						}
						if (existing) {
							clearWindowTopicIconTimer(existing);
						}
						const windowNo = existing?.windowNo ?? nextWindowNo++;
						windows.set(windowId, {
							windowId,
							windowNo,
							socket,
							cwd: typeof message.cwd === "string" ? message.cwd : existing?.cwd ?? process.cwd(),
							sessionName:
								typeof message.sessionName === "string" ? message.sessionName : existing?.sessionName,
							busy: Boolean(message.busy),
							lastTurnText: existing?.lastTurnText,
							lastTurnSeq: existing?.lastTurnSeq ?? 0,
							boundChatId: existing?.boundChatId,
							boundThreadId: existing?.boundThreadId,
							boundTopicTitle: existing?.boundTopicTitle,
							pendingTurns: existing?.pendingTurns ?? 0,
							modelLabel:
								typeof message.modelLabel === "string" ? message.modelLabel : existing?.modelLabel,
							thinkingLevel:
								typeof message.thinkingLevel === "string" ? message.thinkingLevel : existing?.thinkingLevel,
							topicIconState: existing?.topicIconState ?? (Boolean(message.busy) ? "thinking" : "green"),
							topicIconContextPercent: existing?.topicIconContextPercent,
							topicIconLastAppliedState: existing?.topicIconLastAppliedState,
							topicIconLastAppliedId: existing?.topicIconLastAppliedId,
							topicIconLastEditAt: existing?.topicIconLastEditAt,
							topicIconPendingState: existing?.topicIconPendingState,
							topicIconPendingTimer: undefined,
							topicIconUpdateInFlight: false,
							topicIconInFlightState: undefined,
							topicIconInFlightId: undefined,
						});
						const registered = windows.get(windowId);
						const registeredModel = registered ? windowModelLabel(registered) : "unknown";
						const registeredThinking = registered ? windowThinkingLabel(registered) : "unknown";
						console.info(
							`[telegram] Registered window ${windowNo}`,
							typeof message.sessionName === "string" ? message.sessionName : "",
							`busy=${Boolean(message.busy)}`,
							`model=${registeredModel}`,
							`thinking=${registeredThinking}`,
						);

						send({
							type: "registered",
							windowId,
							windowNo,
							ownerUserId: typeof config.ownerUserId === "number" ? config.ownerUserId : null,
							forumChatId: typeof config.forumChatId === "number" ? config.forumChatId : null,
							boundThreadId:
								typeof windows.get(windowId)?.boundThreadId === "number"
									? windows.get(windowId).boundThreadId
									: null,
							boundTopicTitle:
								typeof windows.get(windowId)?.boundTopicTitle === "string"
									? windows.get(windowId).boundTopicTitle
									: null,
						});
						const registeredWindow = windows.get(windowId);
						if (registeredWindow?.topicIconState) {
							scheduleTopicIconUpdate(registeredWindow, registeredWindow.topicIconState, { force: true });
						}
						refreshTypingIndicator();
						break;
					}

					case "meta": {
						if (!windowId) break;
						const current = windows.get(windowId);
						if (!current) break;

						if (typeof message.cwd === "string") current.cwd = message.cwd;
						if (typeof message.sessionName === "string") current.sessionName = message.sessionName;
						if (typeof message.modelLabel === "string") current.modelLabel = message.modelLabel;
						if (typeof message.thinkingLevel === "string") current.thinkingLevel = message.thinkingLevel;
						const wasBusy = current.busy;
						current.busy = Boolean(message.busy);
						if (current.busy) {
							const status = current.activeStatus;
							if (status?.idleDeleteTimer) {
								clearTimeout(status.idleDeleteTimer);
								status.idleDeleteTimer = undefined;
							}
							if (!wasBusy && current.topicIconState !== "thinking") {
								scheduleTopicIconUpdate(current, "thinking");
							}
						} else {
							if (current.activeStatus) {
								scheduleIdleStatusCleanup(current);
							}
							if (wasBusy && current.topicIconState === "thinking") {
								const fallbackState = topicIconStateFromPercent(current.topicIconContextPercent);
								console.warn(
									`[telegram] Busy->idle fallback icon transition for window ${current.windowNo}`,
									`thinking -> ${fallbackState}`,
								);
								scheduleTopicIconUpdate(current, fallbackState);
							}
						}
						refreshTypingIndicator();
						break;
					}

					case "request_pin": {
						if (!windowId) {
							send({ type: "error", error: "not_registered" });
							break;
						}

						let pinCode = "";
						for (let i = 0; i < 12; i += 1) {
							pinCode = String(Math.floor(Math.random() * 1_000_000)).padStart(6, "0");
							if (!pendingPins.has(pinCode)) break;
						}

						const expiresAt = Date.now() + 60_000;
						pendingPins.set(pinCode, { windowId, expiresAt });
						send({ type: "pin", code: pinCode, expiresAt });
						break;
					}

					case "create_topic": {
						if (!windowId) {
							send({ type: "error", error: "not_registered" });
							break;
						}

						const windowState = windows.get(windowId);
						if (!windowState) {
							send({ type: "error", error: "window_missing" });
							break;
						}

						if (typeof config.ownerUserId !== "number" && typeof config.pairedChatId !== "number") {
							send({ type: "error", error: "not_paired" });
							break;
						}

						if (typeof config.forumChatId !== "number") {
							send({ type: "error", error: "forum_not_set" });
							break;
						}

						const topicTitle = sanitizeTopicTitle(
							typeof message.title === "string" ? message.title : undefined,
							windowState,
						);

						void (async () => {
							try {
								if (!bot) throw new Error("bot_not_ready");
								const topic = await bot.createForumTopic(config.forumChatId, topicTitle);
								setWindowTopicBinding(windowState, config.forumChatId, topic.message_thread_id, topic.name ?? topicTitle);

								send({
									type: "topic_created",
									windowId,
									chatId: config.forumChatId,
									messageThreadId: topic.message_thread_id,
									title: windowState.boundTopicTitle,
								});

								await botSendSystemThread(
									bot,
									config.forumChatId,
									topic.message_thread_id,
									[
										`Connected to pi window ${windowState.windowNo}: ${windowDisplayName(windowState)}.`,
										formatWindowRuntimeLine(windowState),
										"Commands: /steer (interrupt), /esc (abort), /help.",
									].join("\n"),
								);
								if (typeof bot.unpinAllForumTopicMessages === "function") {
									try {
										await bot.unpinAllForumTopicMessages(config.forumChatId, topic.message_thread_id);
									} catch {
										// Ignore unpin errors (permissions / API differences).
									}
								}
								refreshTypingIndicator();
							} catch (error) {
								send({ type: "error", error: String(error?.message ?? error) });
							}
						})();
						break;
					}

					case "bind_topic": {
						if (!windowId) {
							send({ type: "error", error: "not_registered" });
							break;
						}
						const windowState = windows.get(windowId);
						if (!windowState) {
							send({ type: "error", error: "window_missing" });
							break;
						}
						if (typeof message.chatId !== "number" || typeof message.messageThreadId !== "number") {
							send({ type: "error", error: "invalid_bind_topic" });
							break;
						}
						setWindowTopicBinding(
							windowState,
							message.chatId,
							message.messageThreadId,
							typeof message.title === "string" ? message.title : windowState.boundTopicTitle,
						);
						send({ type: "ok" });
						refreshTypingIndicator();
						void sweepStaleManagedTopics();
						break;
					}

					case "unpair": {
						clearOwnerPairing()
							.then(() => send({ type: "ok" }))
							.catch((error) => {
								send({ type: "error", error: String(error?.message ?? error) });
							});
						break;
					}

					case "topic_icon": {
						if (!windowId) break;
						const current = windows.get(windowId);
						if (!current) break;
						if (!isTopicIconState(message.state)) {
							send({ type: "error", error: "invalid_topic_icon_state" });
							break;
						}

						if (typeof message.contextPercent === "number" && Number.isFinite(message.contextPercent)) {
							current.topicIconContextPercent = clampContextPercent(message.contextPercent);
						}
						console.info(
							`[telegram] topic_icon event window=${current.windowNo}`,
							`state=${message.state}`,
							typeof current.topicIconContextPercent === "number"
								? `context=${current.topicIconContextPercent.toFixed(1)}%`
								: "",
							`busy=${current.busy}`,
						);
						scheduleTopicIconUpdate(current, message.state);
						break;
					}

					case "turn_progress": {
						if (!windowId) break;
						const current = windows.get(windowId);
						if (!current) break;
						if (!current.activeStatus) break;

						const progressText = typeof message.text === "string" ? message.text : "Thinking…";
						scheduleTurnStatusUpdate(current, progressText);
						break;
					}

					case "turn_end": {
						if (!windowId) break;
						const current = windows.get(windowId);
						if (!current) break;

						const text = typeof message.text === "string" ? message.text.trim() : "";
						if (!text) break;

						void (async () => {
							try {
								current.lastTurnText = text;
								current.lastTurnSeq += 1;

								if (typeof current.boundChatId === "number" && typeof current.boundThreadId === "number") {
									await botSendAssistantThread(bot, current.boundChatId, current.boundThreadId, text);
								}
							} catch (error) {
								console.error("[telegram] Failed to deliver turn_end response", error);
							} finally {
								current.pendingTurns = Math.max(0, (current.pendingTurns || 0) - 1);
								if (!current.activeStatus) return;

								if (current.pendingTurns > 0) {
									current.activeStatus.startedAt = Date.now();
									const queuedText = current.pendingTurns > 1
										? `Working through queue (${current.pendingTurns} requests left)…`
										: "Processing queued request…";
									scheduleTurnStatusUpdate(current, queuedText, { force: true });
									return;
								}

								await deleteTurnStatus(current);
							}
						})();
						break;
					}

					case "shutdown": {
						console.warn("[telegram] Shutdown requested by extension client.");
						send({ type: "ok" });
						void shutdown(0);
						break;
					}

					case "ping": {
						send({ type: "pong" });
						break;
					}

					default:
						break;
				}
			}
		});

		socket.on("close", () => {
			if (windowId) {
				const current = windows.get(windowId);
				if (current && current.socket === socket) {
					if (current.activeStatus) {
						void deleteTurnStatus(current);
					}
					if (isShuttingDown) {
						clearWindowTopicIconTimer(current);
					} else {
						clearWindowTopicBinding(current);
					}
					windows.delete(windowId);
					console.info(`[telegram] Window disconnected: ${current.windowNo} (shuttingDown=${isShuttingDown})`);
				}
			}

			refreshTypingIndicator();
			if (!isShuttingDown) {
				void sweepStaleManagedTopics();
				void maybeShutdownSoon(server);
			}
		});

		socket.on("error", () => {
			// handled via close path
		});
	});

	await new Promise((resolve, reject) => {
		const onError = (error) => {
			server.off("listening", onListening);
			reject(error);
		};
		const onListening = () => {
			server.off("error", onError);
			resolve(undefined);
		};

		server.once("error", onError);
		server.once("listening", onListening);
		server.listen(SOCKET_PATH);
	});

	try {
		fs.chmodSync(SOCKET_PATH, 0o600);
	} catch {
		// Ignore chmod failures.
	}

	try {
		ownedSocketInode = fs.statSync(SOCKET_PATH).ino;
	} catch {
		ownedSocketInode = null;
	}

	return server;
}

const server = await startServer();

bot = new TelegramBot(config.botToken, { polling: true });
bot.on("message", (message) => {
	void handleTelegramMessage(message).catch((error) => {
		console.error("[telegram] Telegram handler error", error);
	});
});
void refreshTopicIconCatalog();
refreshTypingIndicator();
void sweepStaleManagedTopics();

staleTopicSweepIntervalTimer = setInterval(() => {
	void sweepStaleManagedTopics();
}, STALE_TOPIC_SWEEP_INTERVAL_MS);

pinCleanupTimer = setInterval(() => {
	const now = Date.now();
	for (const [pinCode, pending] of pendingPins.entries()) {
		if (now > pending.expiresAt) {
			pendingPins.delete(pinCode);
		}
	}
}, 30_000);

async function shutdown(exitCode = 0) {
	if (isShuttingDown) return;
	isShuttingDown = true;
	unlinkSocketFile();

	const hardExitTimer = setTimeout(() => {
		unlinkSocketFile();
		releaseDaemonLock();
		process.exit(exitCode);
	}, 7000);
	if (typeof hardExitTimer.unref === "function") {
		hardExitTimer.unref();
	}

	try {
		await cleanup(server);
	} finally {
		clearTimeout(hardExitTimer);
		unlinkSocketFile();
		releaseDaemonLock();
		process.exit(exitCode);
	}
}

process.on("SIGINT", () => {
	void shutdown(0);
});

process.on("SIGTERM", () => {
	void shutdown(0);
});

process.on("uncaughtException", (error) => {
	console.error("[telegram] uncaughtException", error);
	void shutdown(1);
});

process.on("unhandledRejection", (reason) => {
	console.error("[telegram] unhandledRejection", reason);
	void shutdown(1);
});

process.on("exit", () => {
	unlinkSocketFile();
	releaseDaemonLock();
});

console.error(`[telegram] Daemon running at ${SOCKET_PATH}`);
console.error(`[telegram] Logging to ${LOG_PATH}`);
