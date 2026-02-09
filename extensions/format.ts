import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import fs from "node:fs";
import path from "node:path";

type CommandResult = {
	code: number | null;
	stdout: string;
	stderr: string;
};

type ToolInput = Record<string, unknown> | undefined;

type ToolName = "edit" | "write";

type PostEditFormatSettings = {
	displayFormatErrors: boolean;
};

type RunCommandOptions = {
	notifyOnError?: boolean;
};

type ToolResultContentItem = {
	type: string;
	text?: string;
};

type ToolResultContent = ToolResultContentItem[];

const PYTHON_EXTENSIONS = new Set([".py"]);
const FRONTEND_EXTENSIONS = new Set([".ts", ".tsx", ".css"]);
const MAX_ERROR_OUTPUT = 4000;
const DEFAULT_POST_EDIT_SETTINGS: PostEditFormatSettings = {
	displayFormatErrors: false,
};
const RUFF_SUMMARY_REGEX = /^Found \d+ error(s)?\.?$/i;
const RUFF_ERROR_HEADER_REGEX = /^Error:\s*ruff check failed:?\s*$/i;

const extractPathFromToolInput = (input: ToolInput): string | null => {
	if (!input) return null;

	const candidates = [
		input.path,
		input.file_path,
		input.filePath,
		input.file,
		input.fileName,
		input.filename,
	];

	for (const candidate of candidates) {
		if (typeof candidate === "string" && candidate.trim()) {
			return candidate;
		}
	}

	return null;
};

const resolvePath = (value: string, cwd: string): string =>
	path.isAbsolute(value) ? path.normalize(value) : path.resolve(cwd, value);

const getSettingsPath = (): string | null => {
	const homeDir = process.env.HOME || process.env.USERPROFILE;
	if (!homeDir) return null;
	return path.join(homeDir, ".pi", "agent", "settings.json");
};

const loadPostEditFormatSettings = (): PostEditFormatSettings => {
	const settingsPath = getSettingsPath();
	if (!settingsPath || !fs.existsSync(settingsPath)) {
		return DEFAULT_POST_EDIT_SETTINGS;
	}

	try {
		const raw = fs.readFileSync(settingsPath, "utf8");
		const settings = JSON.parse(raw) as Record<string, unknown>;
		const postEditSettings = settings.postEditFormat;
		if (postEditSettings && typeof postEditSettings === "object") {
			const displayFormatErrors = (postEditSettings as Record<string, unknown>).displayFormatErrors;
			return {
				displayFormatErrors: displayFormatErrors === true,
			};
		}
	} catch {
		return DEFAULT_POST_EDIT_SETTINGS;
	}

	return DEFAULT_POST_EDIT_SETTINGS;
};

const getFrontendRoot = (filePath: string): string | null => {
	const normalized = path.normalize(filePath);
	const parsed = path.parse(normalized);
	const relative = parsed.root ? path.relative(parsed.root, normalized) : normalized;
	const parts = relative.split(path.sep).filter(Boolean);

	let frontendIndex = -1;
	for (let i = 0; i < parts.length - 1; i += 1) {
		if (parts[i] === "rhythm-app" && parts[i + 1] === "frontendnx") {
			frontendIndex = i + 1;
			break;
		}
	}

	if (frontendIndex < 0) return null;

	const rootParts = parts.slice(0, frontendIndex + 1);
	return path.join(parsed.root || "", ...rootParts);
};

const formatOutputSnippet = (result: CommandResult): string | null => {
	const combined = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
	if (!combined) return null;
	if (combined.length <= MAX_ERROR_OUTPUT) return combined;
	return combined.slice(-MAX_ERROR_OUTPUT);
};

const notify = (ctx: ExtensionContext, message: string, level: "info" | "warning" | "error") => {
	if (!ctx.hasUI) return;
	ctx.ui.notify(message, level);
};

const runCommand = async (
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	command: string,
	args: string[],
	description: string,
	options: RunCommandOptions = {},
): Promise<CommandResult> => {
	const result = await pi.exec(command, args, { cwd: ctx.cwd });
	if (result.code === 0) return result;

	if (options.notifyOnError !== false) {
		const output = formatOutputSnippet(result);
		const message = output ? `${description} failed:\n${output}` : `${description} failed.`;
		notify(ctx, message, "error");
	}

	return result;
};

const stripRuffSummary = (output: string): string => {
	const lines = output.split(/\r?\n/);
	const filtered = lines.filter((line) => {
		const trimmed = line.trim();
		return !RUFF_SUMMARY_REGEX.test(trimmed) && !RUFF_ERROR_HEADER_REGEX.test(trimmed);
	});
	return filtered.join("\n").trim();
};

const buildRuffCheckMessage = (output: string): string | null => {
	const trimmed = stripRuffSummary(output);
	if (!trimmed) return null;
	return `Ruff check reported:\n${trimmed}`;
};

const formatPythonFile = async (
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	filePath: string,
	settings: PostEditFormatSettings,
): Promise<string | null> => {
	const formatResult = await runCommand(
		pi,
		ctx,
		"uv",
		["run", "ruff", "format", filePath],
		"ruff format",
		{ notifyOnError: settings.displayFormatErrors },
	);
	if (formatResult.code !== 0) return null;

	const checkResult = await runCommand(
		pi,
		ctx,
		"uv",
		["run", "ruff", "check", "--fix", filePath],
		"ruff check",
		{ notifyOnError: false },
	);

	const checkOutput = formatOutputSnippet(checkResult);
	if (!checkOutput) return null;
	return buildRuffCheckMessage(checkOutput);
};

const formatFrontendFile = async (pi: ExtensionAPI, ctx: ExtensionContext, filePath: string): Promise<void> => {
	const frontendRoot = getFrontendRoot(filePath);
	if (!frontendRoot || !fs.existsSync(frontendRoot)) {
		return;
	}

	await runCommand(
		pi,
		ctx,
		"pnpm",
		["-C", frontendRoot, "exec", "biome", "check", "--fix", filePath],
		"biome check",
	);
};

const handlePostEdit = async (pi: ExtensionAPI, ctx: ExtensionContext, filePath: string): Promise<string | null> => {
	if (!fs.existsSync(filePath)) {
		notify(ctx, `File not found: ${filePath}`, "error");
		return null;
	}

	const extension = path.extname(filePath).toLowerCase();
	if (PYTHON_EXTENSIONS.has(extension)) {
		const settings = loadPostEditFormatSettings();
		return formatPythonFile(pi, ctx, filePath, settings);
	}

	if (FRONTEND_EXTENSIONS.has(extension)) {
		await formatFrontendFile(pi, ctx, filePath);
	}

	// Silently skip unsupported file types
	return null;
};

const appendToolResultText = (content: ToolResultContent | undefined, appendix: string): ToolResultContent => {
	const updated = content ? [...content] : [];
	updated.push({ type: "text", text: appendix });
	return updated;
};

export default function postEditFormat(pi: ExtensionAPI): void {
	let formatQueue = Promise.resolve();

	pi.on("tool_result", async (event, ctx) => {
		const toolName = event.toolName as ToolName;
		if (toolName !== "edit" && toolName !== "write") return;
		if (event.isError) return;

		const rawPath = extractPathFromToolInput(event.input as ToolInput);
		if (!rawPath) return;

		const resolvedPath = resolvePath(rawPath, ctx.cwd);
		let ruffCheckMessage: string | null = null;

		formatQueue = formatQueue
			.then(async () => {
				ruffCheckMessage = await handlePostEdit(pi, ctx, resolvedPath);
			})
			.catch((error: Error) => {
				notify(ctx, `Post-edit format error: ${error.message}`, "error");
			});

		await formatQueue;

		if (!ruffCheckMessage) return;
		const appendix = `\n\n${ruffCheckMessage}`;
		return {
			content: appendToolResultText(event.content as ToolResultContent | undefined, appendix),
			details: event.details,
			isError: event.isError,
		};
	});
}
