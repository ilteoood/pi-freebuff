import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const AGENT_ID = "base3-free-catalog";
const JSON_SCHEMA_DRAFT = "http://json-schema.org/draft-07/schema#";
const CLI_CONFIG_DIR = process.env.FREEBUFF_CONFIG_DIR ?? path.join(os.homedir(), ".config", "manicode");
const EXTENSIONS_DIR = path.join(import.meta.dirname, "..", ".pi", "extensions");
const PROMPT_FILE = path.join(EXTENSIONS_DIR, "freebuff-system-prompt.txt");
const TOOLS_FILE = path.join(EXTENSIONS_DIR, "freebuff-tools.json");

interface ToolDefinition {
	description?: string;
	inputSchema?: Record<string, unknown>;
}

interface RunState {
	sessionState?: {
		fileContext?: { agentTemplates?: Record<string, { systemPrompt?: string; stepPrompt?: string }> };
		mainAgentState?: { toolDefinitions?: Record<string, ToolDefinition> };
	};
}

function newestRunStateFile(): string | null {
	const projects = path.join(CLI_CONFIG_DIR, "projects");
	if (!fs.existsSync(projects)) return null;
	let newest: { file: string; mtime: number } | null = null;
	for (const project of fs.readdirSync(projects)) {
		const chats = path.join(projects, project, "chats");
		if (!fs.existsSync(chats)) continue;
		for (const chat of fs.readdirSync(chats)) {
			const file = path.join(chats, chat, "run-state.json");
			if (!fs.existsSync(file)) continue;
			const mtime = fs.statSync(file).mtimeMs;
			if (!newest || mtime > newest.mtime) newest = { file, mtime };
		}
	}
	return newest?.file ?? null;
}

function writeIfChanged(file: string, content: string): boolean {
	const current = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
	if (current === content) {
		console.log(`unchanged ${path.basename(file)}`);
		return false;
	}
	fs.writeFileSync(file, content);
	console.log(`updated   ${path.basename(file)} (${current.length} -> ${content.length} chars)`);
	return true;
}

const runStateFile = newestRunStateFile();
if (!runStateFile) {
	console.error(`no Freebuff session state under ${path.join(CLI_CONFIG_DIR, "projects")}`);
	console.error("run the official Freebuff CLI once (freebuff) so it writes its agent definitions, then retry");
	process.exit(1);
}

const state = JSON.parse(fs.readFileSync(runStateFile, "utf8")) as RunState;
console.log(`source    ${runStateFile}`);

const template = state.sessionState?.fileContext?.agentTemplates?.[AGENT_ID];
if (!template?.systemPrompt) {
	console.error(`the session state has no agent template for ${AGENT_ID}`);
	process.exit(1);
}

const prompt = template.systemPrompt.replaceAll("{CODEBUFF_CURRENT_DATE}", "{CURRENT_DATE}");
writeIfChanged(PROMPT_FILE, prompt);

const definitions = state.sessionState?.mainAgentState?.toolDefinitions ?? {};
const tools = Object.entries(definitions).map(([name, definition]) => ({
	type: "function" as const,
	function: {
		name,
		description: definition.description ?? "",
		parameters: { $schema: JSON_SCHEMA_DRAFT, ...(definition.inputSchema ?? {}) },
	},
}));
if (tools.length === 0) {
	console.error("the session state has no tool definitions");
	process.exit(1);
}
writeIfChanged(TOOLS_FILE, `${JSON.stringify(tools, null, "\t")}\n`);
console.log(`tools     ${tools.map((tool) => tool.function.name).join(", ")}`);
