import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { activityMonitor } from "./activity.js";
import type { SearchOptions, SearchResponse, SearchResult } from "./perplexity.js";

const BRAVE_API_URL = "https://api.search.brave.com/res/v1/web/search";
const CONFIG_PATH = join(homedir(), ".pi", "web-search.json");

interface BraveConfig {
	braveApiKey?: string;
}

let cachedConfig: BraveConfig | null = null;

function loadConfig(): BraveConfig {
	if (cachedConfig) return cachedConfig;
	if (existsSync(CONFIG_PATH)) {
		try {
			cachedConfig = JSON.parse(readFileSync(CONFIG_PATH, "utf-8")) as BraveConfig;
			return cachedConfig;
		} catch {}
	}
	cachedConfig = {};
	return cachedConfig;
}

function getApiKey(): string {
	const key = process.env.BRAVE_API_KEY || loadConfig().braveApiKey;
	if (!key) {
		throw new Error(
			"Brave Search API key not found. Either:\n" +
			`  1. Create ${CONFIG_PATH} with { \"braveApiKey\": \"your-key\" }\n` +
			"  2. Set BRAVE_API_KEY environment variable\n" +
			"Get a key at https://api-dashboard.search.brave.com/app/keys",
		);
	}
	return key;
}

export function isBraveAvailable(): boolean {
	return Boolean(process.env.BRAVE_API_KEY || loadConfig().braveApiKey);
}

function mapRecencyFilter(recencyFilter?: SearchOptions["recencyFilter"]): string | undefined {
	if (!recencyFilter) return undefined;
	const map: Record<NonNullable<SearchOptions["recencyFilter"]>, string> = {
		day: "pd",
		week: "pw",
		month: "pm",
		year: "py",
	};
	return map[recencyFilter];
}

function isValidDomain(domain: string): boolean {
	return /^[a-zA-Z0-9][a-zA-Z0-9-_.]*\.[a-zA-Z]{2,}$/.test(domain);
}

function applyDomainFilterToQuery(query: string, domainFilter?: string[]): string {
	if (!domainFilter?.length) return query;

	const includes = domainFilter
		.filter((d) => !d.startsWith("-") && isValidDomain(d))
		.map((d) => `site:${d}`);
	const excludes = domainFilter
		.filter((d) => d.startsWith("-") && isValidDomain(d.slice(1)))
		.map((d) => `-site:${d.slice(1)}`);

	const clauses = [...includes, ...excludes].join(" ");
	if (!clauses) return query;
	return `${query} ${clauses}`.trim();
}

function withTimeout(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
	const timeout = AbortSignal.timeout(timeoutMs);
	return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

interface BraveSearchApiResponse {
	web?: {
		results?: Array<{
			title?: string;
			url?: string;
			description?: string;
		}>;
	};
}

export async function searchWithBrave(query: string, options: SearchOptions = {}): Promise<SearchResponse> {
	const apiKey = getApiKey();
	const count = Math.min(options.numResults ?? 5, 20);
	const transformedQuery = applyDomainFilterToQuery(query, options.domainFilter);

	const params = new URLSearchParams({
		q: transformedQuery,
		count: String(count),
	});

	const freshness = mapRecencyFilter(options.recencyFilter);
	if (freshness) params.set("freshness", freshness);

	const activityId = activityMonitor.logStart({ type: "api", query: transformedQuery });

	let response: Response;
	try {
		response = await fetch(`${BRAVE_API_URL}?${params.toString()}`, {
			headers: {
				Accept: "application/json",
				"Accept-Encoding": "gzip",
				"X-Subscription-Token": apiKey,
			},
			signal: withTimeout(options.signal, 30000),
		});
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		if (message.toLowerCase().includes("abort")) {
			activityMonitor.logComplete(activityId, 0);
		} else {
			activityMonitor.logError(activityId, message);
		}
		throw err;
	}

	if (!response.ok) {
		activityMonitor.logComplete(activityId, response.status);
		if (response.status === 429) {
			const retryAfter = response.headers.get("retry-after");
			throw new Error(
				retryAfter
					? `Brave Search rate limited (HTTP 429). Retry after ${retryAfter}s.`
					: "Brave Search rate limited (HTTP 429).",
			);
		}
		const errorText = await response.text();
		throw new Error(`Brave Search API error ${response.status}: ${errorText.slice(0, 300)}`);
	}

	let data: BraveSearchApiResponse;
	try {
		data = (await response.json()) as BraveSearchApiResponse;
	} catch {
		activityMonitor.logComplete(activityId, response.status);
		throw new Error("Brave Search API returned invalid JSON");
	}

	const results: SearchResult[] = [];
	for (const result of data.web?.results ?? []) {
		if (!result.url) continue;
		results.push({
			title: result.title || "",
			url: result.url,
			snippet: result.description || "",
		});
		if (results.length >= count) break;
	}

	activityMonitor.logComplete(activityId, response.status);
	return { answer: "", results };
}
