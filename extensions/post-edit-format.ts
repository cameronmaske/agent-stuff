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

const PYTHON_EXTENSIONS = new Set([".py"]);
const FRONTEND_EXTENSIONS = new Set([".ts", ".tsx", ".css"]);
const MAX_ERROR_OUTPUT = 4000;

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
): Promise<boolean> => {
	const result = await pi.exec(command, args, { cwd: ctx.cwd });
	if (result.code === 0) return true;

	const output = formatOutputSnippet(result);
	const message = output ? `${description} failed:\n${output}` : `${description} failed.`;
	notify(ctx, message, "error");
	return false;
};

const formatPythonFile = async (pi: ExtensionAPI, ctx: ExtensionContext, filePath: string): Promise<void> => {
	const formatted = await runCommand(pi, ctx, "uv", ["run", "ruff", "format", filePath], "ruff format");
	if (!formatted) return;

	await runCommand(pi, ctx, "uv", ["run", "ruff", "check", "--fix", filePath], "ruff check");
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

const handlePostEdit = async (pi: ExtensionAPI, ctx: ExtensionContext, filePath: string): Promise<void> => {
	if (!fs.existsSync(filePath)) {
		notify(ctx, `File not found: ${filePath}`, "error");
		return;
	}

	const extension = path.extname(filePath).toLowerCase();
	if (PYTHON_EXTENSIONS.has(extension)) {
		await formatPythonFile(pi, ctx, filePath);
		return;
	}

	if (FRONTEND_EXTENSIONS.has(extension)) {
		await formatFrontendFile(pi, ctx, filePath);
	}

	// Silently skip unsupported file types
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
		formatQueue = formatQueue
			.then(() => handlePostEdit(pi, ctx, resolvedPath))
			.catch((error: Error) => {
				notify(ctx, `Post-edit format error: ${error.message}`, "error");
			});
		await formatQueue;
	});
}
