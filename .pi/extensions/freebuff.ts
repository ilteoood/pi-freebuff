import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { randomUUID, generateKeyPairSync } from "node:crypto";
import { streamSimple as builtinStreamSimple, createAssistantMessageEventStream } from "@earendil-works/pi-ai/compat";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage, AssistantMessageEventStream, JsonObject } from "@earendil-works/pi-ai/compat";

const DEFAULT_API_ORIGIN = "https://www.codebuff.com";
const DEFAULT_AUTH_ORIGIN = "https://freebuff.com";
const CATALOG_PROTOCOL = "1";
const CATALOG_STALE_CODE = "freebuff_catalog_stale";
const CATALOG_PATH = "/api/v1/freebuff/models";
const ADMISSION_PATH = "/api/v1/freebuff/session/admission";
const RUNS_PATH = "/api/v1/agent-runs";
const FREE_ROOT_AGENT_ID = "base3-free-catalog";
const SESSION_PATH = "/api/v1/freebuff/session";
const LOGIN_CODE_PATH = "/api/auth/cli/code";
const LOGIN_STATUS_PATH = "/api/auth/cli/status";
const LOGIN_POLL_INTERVAL_MS = 5_000;
const LOGIN_CODE_LIFETIME_MS = 60 * 60_000;
const SIGNED_IN_TTL_MS = 10 * 365 * 24 * 60 * 60_000;
const DEFAULT_CONTEXT_WINDOW = 128_000;
// shortcut: the catalog carries no output-token limit, so every model shares
// one ceiling; upgrade when the catalog exposes a real limit.
const MAX_OUTPUT_TOKENS = 32_000;
const FALLBACK_SESSION_TTL_MS = 30 * 60_000;
const DEVICE_KEYS_PATH = "/api/v1/freebuff/device-keys";
const ME_PATH = "/api/v1/me?fields=id,email";
const CLI_CONFIG_DIR =
	process.env.FREEBUFF_CONFIG_DIR?.trim() || path.join(os.homedir(), ".config", "manicode");
const HEADERS = {
	instance: "x-freebuff-instance-id",
	model: "x-freebuff-model",
	walletSpendLimit: "x-freebuff-wallet-spend-limit",
	catalogProtocol: "x-freebuff-catalog-protocol",
	catalogFetch: "x-freebuff-catalog-fetch",
	client: "x-freebuff-client",
	clientVersion: "x-freebuff-client-version",
	multiSession: "x-freebuff-multi-session",
	purchaseContinuity: "x-freebuff-purchase-continuity",
	takeoverInstance: "x-freebuff-takeover-instance-id",
	sseGzipRecovery: "x-freebuff-sse-gzip-recovery",
	desktopAttempt: "x-freebuff-desktop-attempt-id",
	deviceKey: "x-freebuff-device-key",
	deviceTimestamp: "x-freebuff-device-ts",
	deviceSignature: "x-freebuff-device-sig",
	actingUser: "x-freebuff-acting-user-id",
} as const;

// The server refuses any other user agent as a third-party client.
const OFFICIAL_USER_AGENT =
	"ai-sdk/openai-compatible/0.0.0-test/codebuff ai-sdk/provider-utils/3.0.25 runtime/browser";
const CLIENT_VERSION = "0.2.36";
const CLAIM_PREFIX = "cli:";
const OFFICIAL_SYSTEM_PROMPT =
	readTextFile(path.join(path.dirname(fileURLToPath(import.meta.url)), "freebuff-system-prompt.txt")) ?? "";
const STEP_REMINDER =
	"<system_reminder>Work in batches: put every tool call you can already make into this response (all the searches you can think of, every file worth reading, all the edits you know with their checks in one command). Once every part of the request is done and checked, give the final message instead.</system_reminder>";
const RENEWABLE_GATE_CODES = new Set([
	"session_expired",
	"session_superseded",
	"session_model_mismatch",
]);

interface CatalogRow {
	key: string;
	handle: string;
	displayName: string;
	multimodal: boolean;
	premium: boolean;
	access: "open" | "locked";
	efforts?: string[];
	contextWindow?: number;
	opensAt?: number;
}

interface Catalog {
	protocol: number;
	version: string;
	issuedAt: number;
	refreshAt: number;
	rows: CatalogRow[];
	fetchId?: string;
}

interface AdmissionBody {
	status?: string;
	error?: string;
	code?: string;
	message?: string;
	currentModel?: string;
	currentInstanceId?: string;
	expiresAt?: string;
	limit?: number;
	recentCount?: number;
	resetAt?: string;
	freebucksShortfall?: { price?: number; balance?: number };
	slotLimit?: number;
	concurrency?: string;
	desktopSessionCounts?: { premium?: number; unlimited?: number; nextExpiryAt?: string };
}

function describeFailure(body: AdmissionBody | null): string {
	if (!body) return "unknown error";
	if (body.status === "rate_limited") {
		const shortfall = body.freebucksShortfall;
		const reset = body.resetAt ? `, resets ${body.resetAt}` : "";
		return `the daily free-time pool is exhausted (${body.recentCount ?? "?"} of ${body.limit ?? "?"} minutes used, ${shortfall?.balance ?? "?"} left, a session costs ${shortfall?.price ?? "?"}${reset})`;
	}
	if (body.status === "model_locked") {
		return `the account's free seat is locked to model ${body.currentModel ?? "another model"}; end that session in the Freebuff CLI or use the same model here`;
	}
	if (body.status === "purchase_capacity" || body.status === "purchase_in_use") {
		const holder = body.currentInstanceId ? ` (held by ${body.currentInstanceId})` : "";
		const counts = body.desktopSessionCounts;
		const used = counts ? ` (${counts.unlimited ?? 0} of ${body.slotLimit ?? "?"} tabs in use)` : "";
		const frees = counts?.nextExpiryAt ? `, a slot frees at ${counts.nextExpiryAt}` : "";
		return `all free seats are in use${holder}${used}; wait for a slot${frees} or close the other Freebuff session`;
	}
	return body.message ?? body.error ?? body.code ?? body.status ?? "unknown error";
}

interface LoginCode {
	loginUrl: string;
	fingerprintHash: string;
	expiresAt: string | number;
}

interface LoginCallbacks {
	onAuth(info: { url: string; instructions?: string }): void;
	onProgress?(message: string): void;
	signal?: AbortSignal;
}

type LoginCredentials = {
	access: string;
	refresh: string;
	expires: number;
	[key: string]: unknown;
};

type FetchInput = Parameters<typeof fetch>[0];
type FetchInit = Parameters<typeof fetch>[1];

let catalog: Catalog | null = null;
let catalogFailure: string | null = null;
let catalogDate: string | null = null;
const sessions = new Map<string, number>();

function apiOrigin(): string {
	return (process.env.FREEBUFF_API_ORIGIN?.trim() || DEFAULT_API_ORIGIN).replace(/\/+$/, "");
}

function assertApiUrl(url: string): string {
	const origin = apiOrigin();
	if (!url.startsWith(`${origin}/`)) {
		throw new Error(`freebuff: refusing to call ${url}, only ${origin} is allowed`);
	}
	return url;
}

function authOrigin(): string {
	return (process.env.FREEBUFF_AUTH_ORIGIN?.trim() || DEFAULT_AUTH_ORIGIN).replace(/\/+$/, "");
}


function installId(): string {
	const file = path.join(getAgentDir(), "freebuff-install-id");
	const stored = readTextFile(file)?.trim();
	if (stored && stored.length > 0) return stored;
	const generated = randomUUID();
	fs.mkdirSync(getAgentDir(), { recursive: true });
	fs.writeFileSync(file, generated);
	return generated;
}

function rotateClaimInstanceId(): string {
	const generated = `cli:${randomUUID()}`;
	fs.mkdirSync(getAgentDir(), { recursive: true });
	fs.writeFileSync(path.join(getAgentDir(), "freebuff-claim-id"), generated);
	return generated;
}

function claimInstanceId(): string {
	const stored = readTextFile(path.join(getAgentDir(), "freebuff-claim-id"))?.trim();
	if (stored && stored.length > 0) return stored;
	return rotateClaimInstanceId();
}

function claimAttemptId(): string {
	return claimInstanceId().slice(CLAIM_PREFIX.length);
}

interface DeviceKeyRecord {
	version: 1;
	publicKey: string;
	privateKey: string;
	registrations: Record<string, string>;
}

let deviceSigningKey: { keyId: string; privateKey: CryptoKey } | null = null;
let actingUser: string | null = null;

function base64UrlDecode(value: string): Uint8Array {
	const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
	const binary = atob(base64 + "=".repeat((4 - (base64.length % 4)) % 4));
	const bytes = new Uint8Array(binary.length);
	for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
	return bytes;
}

function base64UrlEncode(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function sha256Hex(value: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
	return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function deviceKeyFile(): string {
	return path.join(getAgentDir(), "freebuff-device-key.json");
}

function parseDeviceKeyRecord(value: unknown): DeviceKeyRecord | null {
	if (!value || typeof value !== "object") return null;
	const record = value as Record<string, unknown>;
	if (record.version !== 1 || typeof record.publicKey !== "string" || typeof record.privateKey !== "string") {
		return null;
	}
	const registrations: Record<string, string> = {};
	if (record.registrations && typeof record.registrations === "object") {
		for (const [scope, keyId] of Object.entries(record.registrations)) {
			if (typeof keyId === "string" && keyId) registrations[scope] = keyId;
		}
	}
	return { version: 1, publicKey: record.publicKey, privateKey: record.privateKey, registrations };
}

function loadDeviceKeyRecord(): DeviceKeyRecord | null {
	const own = parseDeviceKeyRecord(safeParse<unknown>(readTextFile(deviceKeyFile()) ?? "null"));
	if (own) return own;
	const cli = parseDeviceKeyRecord(safeParse<unknown>(readTextFile(path.join(CLI_CONFIG_DIR, "device-key.json")) ?? "null"));
	if (cli) {
		saveDeviceKeyRecord(cli);
		return cli;
	}
	const generated = generateDeviceKeyRecord();
saveDeviceKeyRecord(generated);
return generated;
}

function generateDeviceKeyRecord(): DeviceKeyRecord {
	const pair = generateKeyPairSync("ed25519");
	const spki = pair.publicKey.export({ type: "spki", format: "der" });
	return {
		version: 1,
		publicKey: spki.subarray(spki.length - 32).toString("base64url"),
		privateKey: pair.privateKey.export({ type: "pkcs8", format: "der" }).toString("base64url"),
		registrations: {},
	};
}
function saveDeviceKeyRecord(record: DeviceKeyRecord): void {
	fs.mkdirSync(getAgentDir(), { recursive: true });
	fs.writeFileSync(deviceKeyFile(), JSON.stringify(record));
}

async function ensureDeviceSigningKey(token: string): Promise<{ keyId: string; privateKey: CryptoKey } | null> {
	if (deviceSigningKey) return deviceSigningKey;
	const record = loadDeviceKeyRecord();
	if (!record) return null;
	const scope = `${apiOrigin()} token:${(await sha256Hex(token)).slice(0, 32)}`;
	let keyId = record.registrations[scope];
	if (!keyId) {
		const response = await fetch(`${apiOrigin()}${DEVICE_KEYS_PATH}`, {
			method: "POST",
			headers: {
				authorization: `Bearer ${token}`,
				"user-agent": OFFICIAL_USER_AGENT,
				"content-type": "application/json",
			},
			body: JSON.stringify({ publicKey: record.publicKey, client: "cli" }),
		});
		if (!response.ok) return null;
		const body = (await response.json().catch(() => null)) as { keyId?: string } | null;
		if (!body?.keyId) return null;
		keyId = body.keyId;
		record.registrations[scope] = keyId;
		saveDeviceKeyRecord(record);
	}
	try {
		const privateKey = await crypto.subtle.importKey(
			"pkcs8",
			base64UrlDecode(record.privateKey) as BufferSource,
			{ name: "Ed25519" },
			false,
			["sign"],
		);
		deviceSigningKey = { keyId, privateKey };
		return deviceSigningKey;
	} catch {
		return null;
	}
}

async function deviceHeaders(
	token: string,
	method: string,
	url: string,
	body?: string,
	fetchId?: string,
): Promise<Record<string, string>> {
	const key = await ensureDeviceSigningKey(token).catch(() => null);
	if (!key) return {};
	const timestampMs = Date.now();
	const payload = [
		"freebuff-device-v1",
		method.toUpperCase(),
		new URL(url).pathname,
		String(timestampMs),
		await sha256Hex(body ?? ""),
		fetchId ?? "",
	].join("\n");
	const signature = new Uint8Array(
		await crypto.subtle.sign(
			{ name: "Ed25519" },
			key.privateKey,
			new TextEncoder().encode(payload) as BufferSource,
		),
	);
	return {
		[HEADERS.deviceKey]: key.keyId,
		[HEADERS.deviceTimestamp]: String(timestampMs),
		[HEADERS.deviceSignature]: base64UrlEncode(signature),
	};
}

async function fetchActingUser(token: string): Promise<string | null> {
	if (actingUser) return actingUser;
	const response = await fetch(`${apiOrigin()}${ME_PATH}`, {
		headers: { authorization: `Bearer ${token}`, "user-agent": OFFICIAL_USER_AGENT },
	}).catch(() => null);
	if (!response || !response.ok) return null;
	const body = (await response.json().catch(() => null)) as { id?: string } | null;
	actingUser = typeof body?.id === "string" ? body.id : null;
	return actingUser;
}

function readTextFile(file: string): string | null {
	try {
		return fs.readFileSync(file, "utf8");
	} catch {
		return null;
	}
}

function safeParse<T>(text: string): T | null {
	try {
		return JSON.parse(text) as T;
	} catch {
		return null;
	}
}

function tokenFromCredential(credential: unknown): string | undefined {
	if (!credential || typeof credential !== "object") return undefined;
	const record = credential as Record<string, unknown>;
	const value = record.access ?? record.key;
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

async function fetchCatalog(token: string): Promise<Catalog | null> {
	const response = await fetch(`${apiOrigin()}${CATALOG_PATH}`, {
		headers: {
			authorization: `Bearer ${token}`,
			[HEADERS.catalogProtocol]: CATALOG_PROTOCOL,
			[HEADERS.client]: "cli",
		},
		signal: AbortSignal.timeout(10_000),
	});
	if (!response.ok) throw new Error(`freebuff catalog request failed (${response.status})`);
	catalogDate = response.headers.get("date");
	const parsed = (await response.json()) as Catalog;
	return Array.isArray(parsed?.rows) ? parsed : null;
}

async function refreshCatalog(token: string): Promise<void> {
	try {
		catalog = await fetchCatalog(token);
		catalogFailure = null;
	} catch (error) {
		catalogFailure = error instanceof Error ? error.message : String(error);
	}
}

function availableRows(): CatalogRow[] {
	const current = catalog;
	if (!current) return [];
	return current.rows.filter(
		(row) =>
			row.access === "open" &&
			(row.opensAt === undefined || row.opensAt <= current.issuedAt) &&
			!row.premium,
	);
}

function toModelConfig(row: CatalogRow) {
	return {
		id: row.key,
		name: row.displayName,
		reasoning: (row.efforts?.length ?? 0) > 0,
		input: (row.multimodal ? ["text", "image"] : ["text"]) as ("text" | "image")[],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: row.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
		maxTokens: MAX_OUTPUT_TOKENS,
	};
}

function buildModelList() {
	return availableRows().map(toModelConfig);
}

function parseExpiry(value: unknown): number {
	const parsed = typeof value === "string" ? Date.parse(value) : Number.NaN;
	return Number.isFinite(parsed) ? parsed : Date.now() + FALLBACK_SESSION_TTL_MS;
}

async function createRun(token: string): Promise<string> {
	const response = await fetch(`${apiOrigin()}${RUNS_PATH}`, {
		method: "POST",
		headers: {
			authorization: `Bearer ${token}`,
			"content-type": "application/json",
			"user-agent": OFFICIAL_USER_AGENT,
			[HEADERS.clientVersion]: CLIENT_VERSION,
		},
		body: JSON.stringify({ action: "START", agentId: FREE_ROOT_AGENT_ID, ancestorRunIds: [] }),
	});
	const body = (await response.json().catch(() => null)) as { runId?: string } | null;
	if (!response.ok || typeof body?.runId !== "string") {
		throw new Error(`freebuff run creation failed (${response.status})`);
	}
	return body.runId;
}

interface ActiveRun {
	token: string;
	runId: string;
	steps: number;
}

let activeRun: ActiveRun | null = null;

async function ensureRun(token: string): Promise<string> {
	if (activeRun?.token === token) {
		activeRun.steps += 1;
		return activeRun.runId;
	}
	const runId = await createRun(token);
	activeRun = { token, runId, steps: 1 };
	return runId;
}

async function finishRun(status: "completed" | "failed" | "cancelled"): Promise<void> {
	const run = activeRun;
	if (!run) return;
	activeRun = null;
	try {
		await fetch(`${apiOrigin()}${RUNS_PATH}`, {
			method: "POST",
			headers: {
				authorization: `Bearer ${run.token}`,
				"content-type": "application/json",
				"user-agent": OFFICIAL_USER_AGENT,
				[HEADERS.clientVersion]: CLIENT_VERSION,
			},
			body: JSON.stringify({
				action: "FINISH",
				runId: run.runId,
				status,
				totalSteps: run.steps,
				directCredits: 0,
				totalCredits: 0,
			}),
		});
	} catch (error) {
		console.error(`freebuff: could not finish the agent run (${String(error)})`);
	}
}

async function sendAdmission(
	token: string,
	row: CatalogRow,
	takeoverInstanceId?: string,
): Promise<Response> {
	return fetch(`${apiOrigin()}${ADMISSION_PATH}`, {
		method: "POST",
		headers: {
			authorization: `Bearer ${token}`,
			"user-agent": OFFICIAL_USER_AGENT,
			[HEADERS.clientVersion]: CLIENT_VERSION,
			[HEADERS.instance]: claimInstanceId(),
			[HEADERS.desktopAttempt]: claimAttemptId(),
			[HEADERS.model]: row.handle,
			[HEADERS.walletSpendLimit]: "session",
			[HEADERS.catalogProtocol]: CATALOG_PROTOCOL,
			[HEADERS.multiSession]: "1",
			[HEADERS.purchaseContinuity]: "1",
			...(catalog?.fetchId ? { [HEADERS.catalogFetch]: catalog.fetchId } : {}),
			...(takeoverInstanceId ? { [HEADERS.takeoverInstance]: takeoverInstanceId } : {}),
		},
	});
}

async function endSession(token: string): Promise<void> {
	sessions.clear();
	const claim = claimInstanceId();
	try {
		await fetch(`${apiOrigin()}${SESSION_PATH}`, {
			method: "DELETE",
			headers: { authorization: `Bearer ${token}`, [HEADERS.instance]: claim },
		});
	} catch (error) {
		console.error(`freebuff: could not end the session (${String(error)})`);
	}
	rotateClaimInstanceId();
}

async function admitSession(token: string, row: CatalogRow, allowRefresh = true): Promise<void> {
	let response = await sendAdmission(token, row);
	let body = (await response.json().catch(() => null)) as AdmissionBody | null;
	if (response.status === 409 && body?.currentInstanceId) {
		response = await sendAdmission(token, row, body.currentInstanceId);
		body = (await response.json().catch(() => null)) as AdmissionBody | null;
	}
	if (!response.ok && body?.status === "purchase_claim_released") {
		rotateClaimInstanceId();
		response = await sendAdmission(token, row);
		body = (await response.json().catch(() => null)) as AdmissionBody | null;
	}
	if (!response.ok) {
		if (allowRefresh && JSON.stringify(body ?? {}).includes(CATALOG_STALE_CODE)) {
			await refreshCatalog(token);
			const refreshed = resolveRow(row.key);
			if (refreshed) return admitSession(token, refreshed, false);
		}
		throw new Error(
			`freebuff session admission failed for ${row.displayName} (${response.status}): ${describeFailure(body)}`,
		);
	}
	sessions.set(row.key, parseExpiry(body?.expiresAt));
}

async function ensureSession(token: string, row: CatalogRow): Promise<void> {
	const expiresAt = sessions.get(row.key);
	if (expiresAt !== undefined && expiresAt > Date.now()) return;
	await admitSession(token, row);
}

async function readFailure(response: Response): Promise<{ body: AdmissionBody | null; text: string }> {
	const text = await response.clone().text().catch(() => "");
	return { body: safeParse<AdmissionBody>(text), text };
}

function gateCode(body: AdmissionBody | null, text: string): string | null {
	const declared = body?.code ?? body?.error;
	if (typeof declared === "string") return declared;
	return [...RENEWABLE_GATE_CODES, CATALOG_STALE_CODE].find((candidate) => text.includes(candidate)) ?? null;
}

function resolveRow(key: string): CatalogRow | undefined {
	return availableRows().find((row) => row.key === key);
}

interface ContentPart {
	type: string;
	text?: string;
}

type MessageContent = string | ContentPart[];

interface ChatMessage {
	role: string;
	content: MessageContent;
}

function freebuffRootMessages(messages: unknown): ChatMessage[] {
	const list = (Array.isArray(messages) ? [...(messages as unknown[])] : []) as ChatMessage[];
	const harness = list.find((message) => message.role === "system" || message.role === "developer");
	list[0] = {
		role: "system",
		content: `${officialSystemPrompt()}\n\n${textContent(harness?.content)}`,
	};
	list.push({ role: "user", content: [{ type: "text", text: STEP_REMINDER }] });
	return list;
}

function textContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.map((part) => {
				if (typeof part === "string") return part;
				const text = (part as ContentPart)?.text;
				return typeof text === "string" ? text : "";
			})
			.join("\n");
	}
	return "";
}

function officialSystemPrompt(): string {
	return OFFICIAL_SYSTEM_PROMPT.replace("{CURRENT_DATE}", currentDateLabel());
}

function currentDateLabel(): string {
	const when = catalogDate ? new Date(catalogDate) : new Date();
	return when.toLocaleDateString("en-US", {
		timeZone: "UTC",
		month: "long",
		day: "numeric",
		year: "numeric",
	});
}
// The free-root agent only accepts its own tool catalog, so the request carries
// the official tools and the model's calls are mapped back onto pi's tools.
const OFFICIAL_TOOLS =
	safeParse<unknown[]>(
		readTextFile(path.join(path.dirname(fileURLToPath(import.meta.url)), "freebuff-tools.json")) ?? "",
	) ?? [];

type ToolArguments = Record<string, unknown>;

function translateToolCall(name: string, args: ToolArguments): { name: string; arguments: ToolArguments } {
	switch (name) {
		case "read_files":
			return { name: "read", arguments: { path: firstString(args.paths) } };
		case "str_replace":
			return {
				name: "edit",
				arguments: {
					path: String(args.path ?? ""),
					edits: objectList(args.replacements).map((replacement) => ({
						oldText: String(replacement.oldString ?? ""),
						newText: String(replacement.newString ?? ""),
					})),
				},
			};
		case "write_file":
			return {
				name: "write",
				arguments: { path: String(args.path ?? ""), content: String(args.content ?? "") },
			};
		case "run_terminal_command":
			return {
				name: "bash",
				arguments: {
					command: String(args.command ?? ""),
					...(typeof args.timeout_seconds === "number" ? { timeout: args.timeout_seconds * 1000 } : {}),
				},
			};
		case "code_search":
			return {
				name: "grep",
				arguments: {
					pattern: String(args.pattern ?? ""),
					...(typeof args.cwd === "string" ? { path: args.cwd } : {}),
					...(typeof args.maxResults === "number" ? { limit: args.maxResults } : {}),
				},
			};
		case "glob":
			return {
				name: "find",
				arguments: {
					pattern: String(args.pattern ?? ""),
					...(typeof args.cwd === "string" ? { path: args.cwd } : {}),
					...(typeof args.max_results === "number" ? { limit: args.max_results } : {}),
				},
			};
		case "list_directory":
			return { name: "ls", arguments: { path: String(args.path ?? "") } };
		case "write_todos":
			return {
				name: "todo",
				arguments: {
					action: "create",
					tasks: objectList(args.todos).map((todo) => ({ subject: String(todo.task ?? "") })),
				},
			};
		case "web_search":
			return { name: "web_search", arguments: { query: String(args.query ?? "") } };
		case "read_url":
			return { name: "fetch_content", arguments: { url: String(args.url ?? "") } };
		case "ask_user":
			return {
				name: "ask_user_question",
				arguments: {
					questions: objectList(args.questions).map((question) => ({
						question: String(question.question ?? ""),
						header: String(question.header ?? "Question").slice(0, 16),
						options: objectList(question.options).map((option) => ({
							label: String(option.label ?? ""),
							description: String(option.description ?? option.label ?? ""),
						})),
					})),
				},
			};
		default:
			return { name, arguments: args };
	}
}

function objectList(value: unknown): ToolArguments[] {
	if (!Array.isArray(value)) return [];
	return value.map((entry) =>
		entry && typeof entry === "object" ? (entry as ToolArguments) : ({} as ToolArguments),
	);
}

function firstString(value: unknown): string {
	return Array.isArray(value) && typeof value[0] === "string" ? value[0] : "";
}

function translateToolCalls(message: AssistantMessage): AssistantMessage {
	for (const block of message.content) {
		if (block.type !== "toolCall") continue;
		const translated = translateToolCall(block.name, block.arguments);
		block.name = translated.name;
		block.arguments = translated.arguments as JsonObject;
	}
	return message;
}

function withPiToolCalls(source: AssistantMessageEventStream): AssistantMessageEventStream {
	const target = createAssistantMessageEventStream();
	void (async () => {
		try {
			for await (const event of source) {
				if (event.type === "done") translateToolCalls(event.message);
				target.push(event);
			}
			target.end();
		} catch (error) {
			console.error("freebuff: chat stream failed", error);
			target.end();
		}
	})();
	return target;
}
async function sendChat(
	url: string,
	init: FetchInit,
	payload: Record<string, unknown>,
	row: CatalogRow,
	token: string,
): Promise<Response> {
	await ensureSession(token, row);
	const body = JSON.stringify({
		...payload,
		tools: OFFICIAL_TOOLS,
		model: row.handle,
		messages: freebuffRootMessages(payload.messages),
		provider: { data_collection: "deny" },
		codebuff_metadata: {
			run_id: await ensureRun(token),
			client_id: installId(),
			cost_mode: "free",
			freebuff_instance_id: claimInstanceId(),
			freebuff_multi_session: "1",
			surface: "cli",
		},
	});
	const headers = new Headers(init?.headers);
	headers.set("authorization", `Bearer ${token}`);
	headers.set("user-agent", OFFICIAL_USER_AGENT);
	headers.set(HEADERS.clientVersion, CLIENT_VERSION);
	headers.set(HEADERS.sseGzipRecovery, "1");
	if (catalog?.fetchId) headers.set(HEADERS.catalogFetch, catalog.fetchId);
	for (const [name, value] of Object.entries(await deviceHeaders(token, "POST", url, body, catalog?.fetchId))) {
		headers.set(name, value);
	}
	const user = await fetchActingUser(token);
	if (user) headers.set(HEADERS.actingUser, user);
	return fetch(assertApiUrl(url), { ...init, headers, body });
}

async function requestChat(
	url: string,
	init: FetchInit,
	payload: Record<string, unknown>,
	token: string,
): Promise<Response> {
	const row = resolveRow(String(payload.model));
	if (!row) {
		throw new Error(
			`freebuff model ${String(payload.model)} is not in the current catalog; refresh the model list with /freebuff refresh`,
		);
	}
	const response = await sendChat(url, init, payload, row, token);
	if (response.ok) return response;
	const { body, text } = await readFailure(response);
	const code = gateCode(body, text);
	if (code === CATALOG_STALE_CODE) {
		await refreshCatalog(token);
		const refreshed = resolveRow(String(payload.model));
		if (refreshed) return sendChat(url, init, payload, refreshed, token);
		return response;
	}
	if (code !== null && RENEWABLE_GATE_CODES.has(code)) {
		await endSession(token);
		return sendChat(url, init, payload, row, token);
	}
	if (response.status === 403 || response.status === 429) sessions.clear();
	throw new Error(`freebuff request failed (${response.status}): ${describeFailure(body)}`);
}

function createChatFetch(token: string) {
	return async (input: FetchInput, init?: FetchInit): Promise<Response> => {
		const url = input instanceof Request ? input.url : String(input);
		const rawBody = init?.body;
		if (typeof rawBody !== "string") return fetch(assertApiUrl(url), init);
		return requestChat(
			url,
			init,
			JSON.parse(rawBody) as Record<string, unknown>,
			token,
		);
	};
}

async function requestLoginCode(fingerprintId: string): Promise<LoginCode> {
	const response = await fetch(`${authOrigin()}${LOGIN_CODE_PATH}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ fingerprintId }),
	});
	if (!response.ok) throw new Error(`freebuff sign-in failed (${response.status})`);
	const code = (await response.json().catch(() => null)) as LoginCode | null;
	if (!code?.loginUrl || !code.fingerprintHash || code.expiresAt === undefined) {
		throw new Error("freebuff sign-in returned an unusable code");
	}
	return code;
}

async function pollLoginStatus(
	fingerprintId: string,
	code: LoginCode,
	signal?: AbortSignal,
): Promise<Record<string, unknown>> {
	const query = new URLSearchParams({
		fingerprintId,
		fingerprintHash: code.fingerprintHash,
		expiresAt: String(code.expiresAt),
	});
	const deadline = Date.now() + LOGIN_CODE_LIFETIME_MS;
	while (Date.now() < deadline) {
		if (signal?.aborted) throw new Error("freebuff sign-in cancelled");
		try {
			const response = await fetch(`${authOrigin()}${LOGIN_STATUS_PATH}?${query}`);
			if (response.ok) {
				const body = (await response.json().catch(() => null)) as { user?: Record<string, unknown> } | null;
				if (body?.user) return body.user;
			}
		} catch (error) {
			console.error(`freebuff: sign-in poll failed (${String(error)})`);
		}
		await new Promise((resolve) => setTimeout(resolve, LOGIN_POLL_INTERVAL_MS));
	}
	throw new Error("freebuff sign-in timed out");
}

async function loginFreebuff(callbacks: LoginCallbacks): Promise<LoginCredentials> {
	callbacks.onProgress?.("Requesting a Freebuff sign-in link");
	const fingerprintId = installId();
	const code = await requestLoginCode(fingerprintId);
	callbacks.onAuth({ url: code.loginUrl, instructions: "Approve the sign-in in your browser" });
	callbacks.onProgress?.("Waiting for the sign-in to be approved");
	const user = await pollLoginStatus(fingerprintId, code, callbacks.signal);
	const access = user.authToken;
	if (typeof access !== "string" || access.length === 0) {
		throw new Error("freebuff sign-in returned no token");
	}
	return { access, refresh: "", expires: Date.now() + SIGNED_IN_TTL_MS };
}

function describeStatus(): string {
	const rows = availableRows();
	const lines = [
		`api: ${apiOrigin()}`,
		`auth: ${authOrigin()}`,
		`catalog: ${catalog ? `${catalog.version} (fetch ${catalog.fetchId ?? "none"}, refresh ${new Date(catalog.refreshAt).toISOString()})` : "unavailable"}`,
		catalogFailure ? `catalog error: ${catalogFailure}` : "",
		`models (${rows.length}):`,
		...rows.map((row) => `  ${row.key} → ${row.displayName}`),
	];
	return lines.filter((line) => line.length > 0).join("\n");
}

function registerFreebuff(pi: ExtensionAPI): void {
	pi.registerProvider("freebuff", {
		name: "Freebuff",
		baseUrl: `${apiOrigin()}/api/v1`,
		api: "openai-completions",
		models: buildModelList(),
		refreshModels: async (context) => {
			const token = tokenFromCredential(context.credential);
			if (token) await refreshCatalog(token);
			return buildModelList();
		},
		streamSimple: (model, context, options) => {
			const token = options?.apiKey;
			if (!token) {
				throw new Error("freebuff: run /login and choose Freebuff before using its models");
			}
			return withPiToolCalls(
				builtinStreamSimple(model, context, {
					...options,
					fetch: createChatFetch(token),
				}),
			);
		},
		oauth: {
			name: "Freebuff account",
			login: loginFreebuff,
			refreshToken: async (credentials) => credentials,
			getApiKey: (credentials) => credentials.access,
		},
	});
}

export default async function freebuffExtension(pi: ExtensionAPI): Promise<void> {
	registerFreebuff(pi);

	pi.on("agent_end", () => {
		void finishRun("completed");
	});
	pi.registerCommand("freebuff", {
		description: "Freebuff status; 'refresh' reloads the model catalog",
		handler: async (args, ctx) => {
			const refreshes = args.trim() === "refresh";
			const token = await ctx.modelRegistry.getApiKeyForProvider("freebuff");
			if (token && refreshes) {
				await refreshCatalog(token);
				registerFreebuff(pi);
			}
			if (!token) {
				ctx.ui.notify("freebuff: not signed in (run /login and choose Freebuff)", "warning");
				return;
			}
			ctx.ui.notify(describeStatus(), catalog ? "info" : "warning");
		},
	});
}
