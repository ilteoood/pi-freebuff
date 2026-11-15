import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";

const AGENT_ID = "base3-free-catalog";
const JSON_SCHEMA_DRAFT = "http://json-schema.org/draft-07/schema#";
const FREEBUFF_ORIGIN = "https://www.codebuff.com";
const CLI_USER_AGENT = "ai-sdk/openai-compatible/0.0.0-test/codebuff";
const CLI_CONFIG_DIR =
	process.env.FREEBUFF_CONFIG_DIR ??
	path.join(os.homedir(), ".config", "manicode");
const EXTENSIONS_DIR = path.join(import.meta.dirname, "..", ".pi", "extensions");
const PROMPT_FILE = path.join(EXTENSIONS_DIR, "freebuff-system-prompt.txt");
const TOOLS_FILE = path.join(EXTENSIONS_DIR, "freebuff-tools.json");
const CREDENTIALS_FILE = path.join(CLI_CONFIG_DIR, "credentials.json");
const PROJECTS_DIR = path.join(CLI_CONFIG_DIR, "projects");

const PI_AUTH_PATH =
	process.env.PI_AUTH_PATH ??
	path.join(os.homedir(), ".pi", "agent", "auth.json");

const DRIVER_TIMEOUT_MS = 120_000;
const DRIVER_RENDER_WAIT_MS = 4_000;
const DRIVER_STATE_WAIT_MS = 90_000;

interface ToolDefinition {
	description?: string;
	inputSchema?: Record<string, unknown>;
}

interface RunState {
	sessionState?: {
		fileContext?: {
			agentTemplates?: Record<
				string,
				{ systemPrompt?: string; stepPrompt?: string }
			>;
		};
		mainAgentState?: { toolDefinitions?: Record<string, ToolDefinition> };
	};
}

function loadPiToken(): string | null {
	if (!fs.existsSync(PI_AUTH_PATH)) return null;
	try {
		const auth = JSON.parse(fs.readFileSync(PI_AUTH_PATH, "utf8")) as {
			freebuff?: { access?: string };
		};
		return auth.freebuff?.access ?? null;
	} catch {
		return null;
	}
}

function generateFingerprintId(token: string): string {
	const raw = [
		os.hostname(),
		os.userInfo().username,
		os.homedir(),
		os.platform(),
		os.arch(),
		token.slice(-12),
	].join("\x1f");
	const hex = crypto.createHash("sha256").update(raw).digest("hex").slice(0, 32);
	return `legacy-${hex}`;
}

function hashOpaque(token: string, fingerprintId: string): string {
	return crypto
		.createHash("sha256")
		.update(`${fingerprintId}\n${token.slice(-24)}`)
		.digest("hex");
}

async function bootstrapCredentials(token: string): Promise<{
	written: boolean;
	fingerprintId: string;
}> {
	const fingerprintId = generateFingerprintId(token);
	const fingerprintHash = hashOpaque(token, fingerprintId);

	if (fs.existsSync(CREDENTIALS_FILE)) {
		try {
			const current = JSON.parse(fs.readFileSync(CREDENTIALS_FILE, "utf8")) as {
				default?: { authToken?: string };
			};
			if (current.default?.authToken === token) {
				console.log(
					`creds     ${CREDENTIALS_FILE} (unchanged for current token)`,
				);
				return { written: false, fingerprintId };
			}
		} catch {
			// fall through and rewrite
		}
	}

	const response = await fetch(
		`${FREEBUFF_ORIGIN}/api/v1/me?fields=id,email,name`,
		{
			headers: {
				authorization: `Bearer ${token}`,
				"user-agent": CLI_USER_AGENT,
			},
		},
	);
	if (!response.ok) {
		throw new Error(
			`/api/v1/me returned ${response.status}: ${(await response.text()).slice(0, 200)}`,
		);
	}
const me = (await response.json()) as {
		id?: string;
		email?: string;
		name?: string | null;
	};
	const user = me;
	if (!user?.id || !user?.email) {
		throw new Error("/api/v1/me returned no user id/email");
	}

	fs.mkdirSync(CLI_CONFIG_DIR, { recursive: true });
	fs.writeFileSync(
		CREDENTIALS_FILE,
		`${JSON.stringify(
			{
				default: {
					id: user.id,
					email: user.email,
					name: user.name ?? null,
					authToken: token,
					fingerprintId,
					fingerprintHash,
				},
			},
			null,
			2,
		)}\n`,
	);
	console.log(`creds     ${CREDENTIALS_FILE} (provisional; runs the CLI)`);
	return { written: true, fingerprintId };
}

function whichBinary(candidates: string[]): string | null {
	const pathVar = process.env.PATH ?? "";
	const dirs = pathVar.split(path.delimiter);
	for (const candidate of candidates) {
		if (candidate.includes(path.sep)) {
			if (fs.existsSync(candidate) && fs.statSync(candidate).mode & 0o111) {
				return candidate;
			}
			continue;
		}
		for (const dir of dirs) {
			const abs = path.join(dir, candidate);
			if (fs.existsSync(abs) && fs.statSync(abs).mode & 0o111) return abs;
		}
	}
	return null;
}

async function driveCli(
	bin: string,
	onStateFile: (file: string) => void,
): Promise<void> {
	const script = whichBinary(["script"]);
	if (!script) {
		throw new Error(
			"the `script(1)` utility is required to drive the Freebuff CLI's TUI but is not on PATH",
		);
	}

	const child = spawn(script, ["-q", "-c", bin, "/dev/null"], {
		stdio: ["pipe", "pipe", "pipe"],
		env: { ...process.env, TERM: "dumb" },
	});
	child.stdout?.resume();
	child.stderr?.resume();

	const exit = new Promise<number>((resolve, reject) => {
		child.once("error", reject);
		child.once("exit", (code) => resolve(code ?? 1));
	});

	await new Promise<void>((resolve) => setTimeout(resolve, DRIVER_RENDER_WAIT_MS));
	child.stdin?.write("reply with the word ready\n");

	const deadline = Date.now() + DRIVER_STATE_WAIT_MS;
	let found: string | null = null;
	while (Date.now() < deadline) {
		await new Promise<void>((resolve) => setTimeout(resolve, 500));
		const file = newestRunStateFile();
		if (file) {
			found = file;
			onStateFile(file);
			break;
		}
	}

	child.stdin?.end();
	const exitCode = await Promise.race([
		exit,
		new Promise<1>((resolve) =>
			setTimeout(() => {
				child.kill("SIGTERM");
				resolve(1);
			}, DRIVER_TIMEOUT_MS - DRIVER_RENDER_WAIT_MS - DRIVER_STATE_WAIT_MS),
		),
	]);
	if (!found) {
		throw new Error(
			`the Freebuff CLI did not write a session state under ${PROJECTS_DIR} within ${DRIVER_STATE_WAIT_MS / 1000}s (exit ${exitCode})`,
		);
	}
}

function newestRunStateFile(): string | null {
	if (!fs.existsSync(PROJECTS_DIR)) return null;
	const candidates: { file: string; mtime: number }[] = [];
	const walk = (dir: string) => {
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) walk(full);
			else if (entry.name === "run-state.json") {
				candidates.push({ file: full, mtime: fs.statSync(full).mtimeMs });
			}
		}
	};
	walk(PROJECTS_DIR);
	candidates.sort((a, b) => b.mtime - a.mtime);
	return candidates[0]?.file ?? null;
}

function harvest(file: string): { promptChanged: boolean; toolsChanged: boolean } {
	const state = JSON.parse(fs.readFileSync(file, "utf8")) as RunState;
	console.log(`source    ${file}`);

	const template = state.sessionState?.fileContext?.agentTemplates?.[AGENT_ID];
	if (!template?.systemPrompt) {
		throw new Error(
			`the session state has no agent template for ${AGENT_ID} (file at ${file})`,
		);
	}
	const prompt = template.systemPrompt.replaceAll(
		"{CODEBUFF_CURRENT_DATE}",
		"{CURRENT_DATE}",
	);
	const promptChanged = writeIfChanged(PROMPT_FILE, prompt);

	const definitions = state.sessionState?.mainAgentState?.toolDefinitions ?? {};
	const tools = Object.entries(definitions).map(([name, definition]) => ({
		type: "function" as const,
		function: {
			name,
			description: definition.description ?? "",
			parameters: {
				$schema: JSON_SCHEMA_DRAFT,
				...(definition.inputSchema ?? {}),
			},
		},
	}));
	if (tools.length === 0) {
		throw new Error("the session state has no tool definitions");
	}
	const toolsChanged = writeIfChanged(
		TOOLS_FILE,
		`${JSON.stringify(tools, null, "\t")}\n`,
	);
	console.log(
		`tools     ${tools.map((tool) => tool.function.name).join(", ")}`,
	);
	return { promptChanged, toolsChanged };
}

function writeIfChanged(file: string, content: string): boolean {
	const current = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
	if (current === content) {
		console.log(`unchanged ${path.basename(file)}`);
		return false;
	}
	fs.writeFileSync(file, content);
	console.log(
		`updated   ${path.basename(file)} (${current.length} -> ${content.length} chars)`,
	);
	return true;
}

async function main() {
	const token = loadPiToken();
	if (!token) {
		console.error(
			`No Freebuff token under ${PI_AUTH_PATH}; run \`pi auth --provider freebuff\` first.`,
		);
		process.exit(1);
	}
	console.log(`auth      ${PI_AUTH_PATH} (token ${token.slice(0, 6)}…)`);

await bootstrapCredentials(token);
	const existing = newestRunStateFile();
	if (existing) {
		harvest(existing);
		return;
	}

	const bin = whichBinary(["freebuff"]);
	if (!bin) {
		console.error(
			`No Freebuff session state under ${PROJECTS_DIR} and no \`freebuff\` binary on PATH.`,
		);
		console.error(
			"Install it (\`npm i -g freebuff\`) so this script can drive one session, then retry.",
		);
		process.exit(1);
	}
	console.log(`driver    ${bin}`);

	await driveCli(bin, (file) => console.log(`state     ${file}`));
	const after = newestRunStateFile();
	if (!after) {
		console.error("driver finished without producing a run-state.json");
		process.exit(1);
	}
	harvest(after);
}

await main();
