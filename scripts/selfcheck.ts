import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.PI_CODING_AGENT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "freebuff-selfcheck-"));

const { default: freebuffExtension } = await import("../.pi/extensions/freebuff.ts");

interface ProviderConfig {
	name?: string;
	baseUrl?: string;
	api?: string;
	models: unknown[];
	oauth?: { name: string };
	refreshModels?: (context: { credential?: unknown }) => Promise<unknown>;
	streamSimple?: (
		model: unknown,
		context: unknown,
		options?: { apiKey?: string },
	) => AsyncIterable<unknown>;
}

interface CapturedRequest {
	url: string;
	method: string;
	headers: Record<string, string>;
	body: Record<string, unknown> | null;
}

const registration: { provider?: ProviderConfig; commands: string[] } = { commands: [] };
const agentEndHandlers: (() => void)[] = [];

const fakePi = {
	registerProvider(_id: string, config: unknown) {
		registration.provider = config as ProviderConfig;
	},
	registerCommand(name: string) {
		registration.commands.push(name);
	},
	on(event: string, handler: () => void) {
		if (event === "agent_end") agentEndHandlers.push(handler);
	},
};
await freebuffExtension(fakePi as never);

const provider = registration.provider;
if (!provider) throw new Error("provider was not registered");
if (provider.api !== "openai-completions") throw new Error(`unexpected api: ${provider.api}`);
if (provider.baseUrl !== "https://www.codebuff.com/api/v1") {
	throw new Error(`unexpected baseUrl: ${provider.baseUrl}`);
}
if (!provider.oauth) throw new Error("oauth login was not registered");
if (!registration.commands.includes("freebuff")) throw new Error("freebuff command was not registered");

const OFFICIAL_USER_AGENT =
	"ai-sdk/openai-compatible/0.0.0-test/codebuff ai-sdk/provider-utils/3.0.25 runtime/browser";
const ROOT_PROMPT_OPENING = "You are Buffy, the coding agent behind Codebuff.";

const requests: CapturedRequest[] = [];

function jsonResponse(payload: unknown): Response {
	return new Response(JSON.stringify(payload), {
		status: 200,
		headers: { "content-type": "application/json" },
	});
}

function sseResponse(): Response {
	const chunk = {
		id: "chatcmpl-selfcheck",
		object: "chat.completion.chunk",
		created: 0,
		model: "deepseek/deepseek-v4.1-flash",
		choices: [{ index: 0, delta: { content: "ready" }, finish_reason: null }],
	};
	const toolCall = {
		id: "chatcmpl-selfcheck",
		object: "chat.completion.chunk",
		created: 0,
		model: "deepseek/deepseek-v4.1-flash",
		choices: [
			{
				index: 0,
				delta: {
					tool_calls: [
						{
							index: 0,
							id: "call-selfcheck",
							type: "function",
							function: { name: "read_files", arguments: '{"paths":["notes.md"]}' },
						},
					],
				},
				finish_reason: null,
			},
		],
	};
	const finished = {
		id: "chatcmpl-selfcheck",
		object: "chat.completion.chunk",
		created: 0,
		model: "deepseek/deepseek-v4.1-flash",
		choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
	};
	const sseBody = [chunk, toolCall, finished]
		.map((part) => `data: ${JSON.stringify(part)}\n\n`)
		.join("");
	return new Response(`${sseBody}data: [DONE]\n\n`, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

function headerRecord(init: HeadersInit | undefined): Record<string, string> {
	const record: Record<string, string> = {};
	new Headers(init).forEach((value, key) => {
		record[key] = value;
	});
	return record;
}

globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
	const url = typeof input === "string" ? input : String((input as Request).url);
	const method = init?.method ?? "GET";
	const rawBody = typeof init?.body === "string" ? init.body : "";
	requests.push({
		url,
		method,
		headers: headerRecord(init?.headers),
		body: rawBody ? (JSON.parse(rawBody) as Record<string, unknown>) : null,
	});
	if (url.endsWith("/api/v1/freebuff/models")) {
		return jsonResponse({
			protocol: 1,
			version: "v0.selfcheck",
			issuedAt: Date.now(),
			refreshAt: Date.now() + 60_000,
			fetchId: "fetch-selfcheck",
			rows: [
				{
					key: "m-selfcheck",
					handle: "fbm1.SELFCHECK",
					displayName: "Selfcheck Model",
					multimodal: false,
					premium: false,
					access: "open",
					efforts: ["low"],
					contextWindow: 100_000,
				},
			],
		});
	}
	if (url.endsWith("/api/v1/agent-runs")) return jsonResponse({ runId: "run-selfcheck" });
	if (url.endsWith("/api/v1/freebuff/device-keys")) return jsonResponse({ keyId: "key-selfcheck" });
	if (url.endsWith("/api/v1/me?fields=id,email")) return jsonResponse({ id: "user-selfcheck" });
	if (url.endsWith("/api/v1/freebuff/session/admission")) {
		return jsonResponse({
			status: "active",
			expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
		});
	}
	if (url.endsWith("/api/v1/chat/completions")) return sseResponse();
	throw new Error(`unexpected request: ${method} ${url}`);
}) as typeof fetch;

const refreshed = await provider.refreshModels?.({ credential: { access: "test-token" } });
if (!Array.isArray(refreshed) || refreshed.length !== 1) {
	throw new Error(`expected one catalog model, got ${JSON.stringify(refreshed)}`);
}

const model = {
	id: "m-selfcheck",
	name: "Selfcheck Model",
	api: "openai-completions",
	provider: "freebuff",
	baseUrl: provider.baseUrl,
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 100_000,
	maxTokens: 32_000,
};

const stream = provider.streamSimple?.(
	model,
	{ systemPrompt: "You are pi.", messages: [{ role: "user", content: "say ready" }] },
	{ apiKey: "test-token" },
);
if (!stream) throw new Error("streamSimple was not registered");
const events: { type: string; message?: { content: { type: string; name?: string; arguments?: unknown }[] } }[] = [];
for await (const event of stream as AsyncIterable<{
	type: string;
	message?: { content: { type: string; name?: string; arguments?: unknown }[] };
}>) {
	events.push(event);
}

const finalMessage = events.find((event) => event.type === "done")?.message;
const toolCall = finalMessage?.content.find((block) => block.type === "toolCall");
if (!toolCall) throw new Error("the model tool call did not reach the stream");
if (toolCall.name !== "read") throw new Error(`the tool call was not mapped to pi: ${String(toolCall.name)}`);
if (JSON.stringify(toolCall.arguments) !== JSON.stringify({ path: "notes.md" })) {
	throw new Error(`the tool call arguments were not mapped: ${JSON.stringify(toolCall.arguments)}`);
}

const chat = requests.find((request) => request.url.endsWith("/chat/completions"));
if (!chat) throw new Error("no chat request was sent");
if (chat.headers["user-agent"] !== OFFICIAL_USER_AGENT) {
	throw new Error(`unexpected user agent: ${chat.headers["user-agent"]}`);
}
if (chat.headers["authorization"] !== "Bearer test-token") {
	throw new Error("missing authorization header");
}
if (chat.headers["x-freebuff-client-version"] !== "0.2.36") {
	throw new Error("missing client version header");
}
if (chat.headers["x-freebuff-sse-gzip-recovery"] !== "1") {
	throw new Error("missing sse gzip recovery header");
}
if (chat.headers["x-freebuff-device-key"] !== "key-selfcheck") {
	throw new Error("missing device key header");
}
if (chat.headers["x-freebuff-acting-user-id"] !== "user-selfcheck") {
	throw new Error("missing acting user header");
}

const body = chat.body ?? {};
if (body.model !== "fbm1.SELFCHECK") throw new Error(`unexpected model: ${String(body.model)}`);

const metadata = body.codebuff_metadata as Record<string, unknown> | undefined;
if (metadata?.run_id !== "run-selfcheck") throw new Error("missing run id");
if (metadata?.cost_mode !== "free") throw new Error("missing cost mode");
if (!String(metadata?.freebuff_instance_id).startsWith("cli:")) {
	throw new Error("missing session claim id");
}

const messages = body.messages as { role: string; content: unknown }[];
if (!String(messages[0]?.content).startsWith(ROOT_PROMPT_OPENING)) {
	throw new Error("the system prompt is not a freebuff root prompt");
}
if (String(messages[0]?.content).includes("{CURRENT_DATE}")) {
	throw new Error("the system prompt still has the date placeholder");
}
if (!String(messages[0]?.content).includes("Stay inside the project folder")) {
	throw new Error("the system prompt is missing the freebuff root rules");
}
const last = messages[messages.length - 1];
if (!JSON.stringify(last?.content).includes("Work in batches:")) {
	throw new Error("the step reminder is missing");
}

const admission = requests.find((request) => request.url.endsWith("/session/admission"));
if (!admission) throw new Error("no session admission was sent");
if (admission.headers["x-freebuff-model"] !== "fbm1.SELFCHECK") {
	throw new Error("the admission did not carry the catalog handle");
}
if (admission.headers["x-freebuff-wallet-spend-limit"] !== "session") {
	throw new Error("the admission did not carry the wallet spend limit");
}
if (admission.headers["x-freebuff-desktop-attempt-id"] !== admission.headers["x-freebuff-instance-id"]?.slice(4)) {
	throw new Error("the admission did not carry the attempt id");
}
for (const handler of agentEndHandlers) handler();
await new Promise((resolve) => setTimeout(resolve, 20));
const finish = requests.find(
	(request) => request.url.endsWith("/api/v1/agent-runs") && request.body?.action === "FINISH",
);
if (!finish) throw new Error("the agent run was not finished at the end of the agent loop");
if (finish.body?.runId !== "run-selfcheck") throw new Error("the wrong run was finished");

console.log(
	`self-check ok: ${provider.name} → ${provider.baseUrl} (${refreshed.length} catalog model, request shape verified)`,
);
