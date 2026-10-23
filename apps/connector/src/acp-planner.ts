/**
 * `chopin acp-planner -- <ACP agent command>` runs a document's Planner turns in any ACP agent. It
 * attaches to the document over the agent connection (docs/agent-connection.md) and gives each
 * Chopin Planner session its own agent, started on the session's first turn. That agent gets one
 * MCP server, `chopin`, whose tools are the turn's host tools: its calls go back to Chopin as
 * host-tool-call, and its replies stream back as parts. Chopin keeps the document, Decisions and
 * every permission check; the agent works in a checkout of the document's repository.
 */

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import { ClientApp, PROTOCOL_VERSION } from "@agentclientprotocol/sdk";
import type {
	McpServer,
	RequestPermissionRequest,
	RequestPermissionResponse,
	SessionNotification,
	StopReason,
	Usage,
} from "@agentclientprotocol/sdk";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { AgentRefused, connectAgent } from "@chopin/agent-link/client";
import type { AgentClient, AgentOptions, LinkClosed, TurnContext } from "@chopin/agent-link/client";
import type { ServerMessageOf, StreamPart } from "@chopin/agent-link";
import { initialize, startAgent } from "./acp";
import { parseArgs } from "./args";
import { bridgeCommand } from "./bridge";
import { serveLocalBridge } from "./local-bridge";
import { SELF } from "./machine";
import { VERSION } from "./version";

/** The MCP server the agent finds Chopin's tools under. */
export const MCP_SERVER = "chopin";
/** The stdio proxy's endpoint, for an agent that takes no HTTP MCP servers. */
export const MCP_URL_VARIABLE = "CHOPIN_ACP_PLANNER_MCP_URL";
export const MCP_TOKEN_VARIABLE = "CHOPIN_ACP_PLANNER_MCP_TOKEN";

/** Starting an agent can include a herdr workspace or a model login; give it time. */
const START_MS = 120_000;
/** How long a cancelled prompt may wind down before its agent is stopped. */
const WIND_DOWN_MS = 10_000;
/** Shutdown must finish inside the connector's 5 seconds before it kills the backend. */
const CLOSE_MS = 1_000;
const DETACH_MS = 2_000;
/** A text part's most characters, so a long reply never outgrows the link's 2 MiB frames. */
const MAX_DELTA = 100_000;
const EMPTY_USAGE = { inputTokens: {}, outputTokens: {} };
const FINISH: Partial<Record<StopReason, "stop" | "length" | "content-filter" | "other">> = {
	end_turn: "stop",
	max_tokens: "length",
	max_turn_requests: "length",
	refusal: "content-filter",
};

type Turn = ServerMessageOf<"turn">;
type HostTool = Turn["tools"][number];
type Format = Extract<NonNullable<Turn["responseFormat"]>, { type: "json" }>;
type ToolCall = RequestPermissionRequest["toolCall"];
/** What earlier `tool_call` updates said about a call that a permission request names by id. */
type Known = Pick<ToolCall, "kind" | "title" | "locations">;

export type PlannerOptions = {
	/** The Chopin origin. */
	url: string;
	/** A GitHub token with push access to the document's repository, or a Planner credential. */
	token: string;
	/** The document's id or URL. */
	document: string;
	/** The ACP agent's command, run in `cwd` with `env`. */
	command: string[];
	cwd: string;
	env: NodeJS.ProcessEnv;
	checkout?: AgentOptions["checkout"];
	/** `read` allows reads and searches inside `cwd` and Chopin's tools; `all` allows every request. */
	allow: "read" | "all";
	/** How a request is declined: `reject` picks the agent's reject option, `cancel` answers cancelled. */
	decline: "reject" | "cancel";
	log(line: string): void;
	/** Detaches when aborted. */
	signal?: AbortSignal;
	/** Tests replace the agent connection. */
	connect?: (options: AgentOptions) => Promise<AgentClient>;
	/** How an agent without HTTP MCP starts the stdio proxy; this chopin's own by default. */
	proxy?: { command: string; args: string[] };
	/** Tests shorten the wind-down. */
	windDownMs?: number;
};

/**
 * The turn's prompt as one ACP prompt: the Planner's instructions whenever they differ from the
 * ones this agent last got (ACP has no system prompt), and for a JSON turn what to answer with.
 */
export function promptText(turn: Turn, previous: string | undefined): string {
	let parts: string[] = [];
	if (turn.instructions !== undefined && turn.instructions !== previous) {
		parts.push(
			`<chopin_instructions>\nYou are the Planner of a Chopin document. Chopin's tools are the `
				+ `"${MCP_SERVER}" MCP server's tools; the instructions name them without that prefix.\n\n`
				+ `${turn.instructions}\n</chopin_instructions>`,
		);
	}
	parts.push(turn.prompt);
	let format = turn.responseFormat?.type === "json" ? turn.responseFormat : undefined;
	if (format) {
		parts.push(
			`Answer with one JSON value and nothing else${
				format.schema ? `, matching this JSON Schema:\n${JSON.stringify(format.schema)}` : "."
			}`,
		);
	}
	return parts.join("\n\n");
}

/** The JSON value a reply holds: the whole reply, a fenced block, or its outermost object or array. */
export function jsonReply(text: string): unknown {
	let trimmed = text.trim();
	let candidates = [trimmed, /```(?:json)?[ \t]*\n([\s\S]*?)\n?```/.exec(trimmed)?.[1]];
	for (let [open, close] of [["{", "}"], ["[", "]"]] as const) {
		let start = trimmed.indexOf(open);
		let end = trimmed.lastIndexOf(close);
		if (start >= 0 && end > start) candidates.push(trimmed.slice(start, end + 1));
	}
	for (let candidate of candidates) {
		if (candidate === undefined) continue;
		try {
			return JSON.parse(candidate);
		} catch {
			// Try the next reading.
		}
	}
	throw new Error("The agent did not answer with the JSON this turn asks for.");
}

/** Whether `path`, taken from `root`, stays inside it once symbolic links are followed. */
function inside(root: string, path: string): boolean {
	let real = (target: string) => {
		try {
			return realpathSync(target);
		} catch {
			return target;
		}
	};
	let within = relative(real(root), real(resolve(root, path)));
	return within === "" || within !== ".." && !within.startsWith(`..${sep}`) && !isAbsolute(within);
}

/** Whether a permission request is for one of the turn's Chopin tools, as agents title MCP calls. */
function chopinTool(title: string | null | undefined, tools: ReadonlyMap<string, HostTool>) {
	if (!title) return false;
	let name = title.replace(/^(mcp__chopin__|chopin[:/.]\s*)/, "");
	return name !== title && tools.has(name) || tools.has(title);
}

/**
 * Answers an agent's permission request without asking anyone. Chopin's tools are allowed when
 * the request claims no other kind, since a title alone is the model's word. Reads and searches
 * are allowed inside `cwd`; with `allow: "all"`, everything. An isolated session has no `cwd`
 * and may use only Chopin's tools.
 */
export function permission(
	request: RequestPermissionRequest,
	policy: {
		allow: PlannerOptions["allow"];
		decline: PlannerOptions["decline"];
		cwd: string | undefined;
		tools: ReadonlyMap<string, HostTool>;
	},
	known: Known = {},
): RequestPermissionResponse {
	let call = request.toolCall;
	let kind = call.kind ?? known.kind;
	let locations = call.locations ?? known.locations ?? [];
	let cwd = policy.cwd;
	let allowed =
		(kind == null || kind === "other") && chopinTool(call.title ?? known.title, policy.tools)
		|| cwd !== undefined && (
				policy.allow === "all"
				|| kind === "think"
				|| (kind === "read" || kind === "search") && locations.length > 0
					&& locations.every(location => inside(cwd, location.path))
			);
	let pick = (...kinds: string[]) =>
		kinds.map(wanted => request.options.find(option => option.kind === wanted)).find(Boolean);
	let option = allowed
		? pick("allow_once", "allow_always")
		: policy.decline === "reject"
		? pick("reject_once", "reject_always")
		: undefined;
	return option
		? { outcome: { outcome: "selected", optionId: option.optionId } }
		: { outcome: { outcome: "cancelled" } };
}

/** Streams an agent's replies as text and reasoning parts, or keeps a JSON turn's text whole. */
export function streamer(emit: (part: StreamPart) => void, buffer: boolean) {
	let open: { type: "text" | "reasoning"; id: string } | undefined;
	let kept = "";
	let close = () => {
		if (open) emit({ type: `${open.type}-end`, id: open.id });
		open = undefined;
	};
	let write = (type: "text" | "reasoning", delta: string) => {
		if (!delta) return;
		if (open?.type !== type) {
			close();
			open = { type, id: randomUUID() };
			emit({ type: `${type}-start`, id: open.id });
		}
		for (let at = 0; at < delta.length; at += MAX_DELTA) {
			emit({ type: `${type}-delta`, id: open.id, delta: delta.slice(at, at + MAX_DELTA) });
		}
	};
	return {
		update(update: SessionNotification["update"]) {
			if (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text") {
				if (buffer) kept += update.content.text;
				else write("text", update.content.text);
			} else if (update.sessionUpdate === "agent_thought_chunk" && update.content.type === "text") {
				write("reasoning", update.content.text);
			}
		},
		finish(format: Format | undefined) {
			if (format) write("text", JSON.stringify(jsonReply(kept)));
			close();
		},
	};
}

function count(number: unknown): number | undefined {
	return Number.isSafeInteger(number) && (number as number) >= 0 ? number as number : undefined;
}

function present(fields: Record<string, number | undefined>): Record<string, number> {
	return Object.fromEntries(
		Object.entries(fields).filter((entry): entry is [string, number] => entry[1] !== undefined),
	);
}

/** ACP's token counts, as far as they are counts, in the link's usage shape. */
function usage(value: Usage | null | undefined) {
	if (!value) return EMPTY_USAGE;
	return {
		inputTokens: present({
			total: count(value.inputTokens),
			cacheRead: count(value.cachedReadTokens),
			cacheWrite: count(value.cachedWriteTokens),
		}),
		outputTokens: present({
			total: count(value.outputTokens),
			reasoning: count(value.thoughtTokens),
		}),
	};
}

type Agent = {
	connection: ReturnType<typeof startAgent>["connection"];
	sessionId: string;
	cancel(): void;
	stop(): Promise<void>;
};

/** The turn whose prompt is in flight: the only one tool calls and permission answers serve. */
type Prompt = {
	context: TurnContext;
	stream: ReturnType<typeof streamer>;
	tools: ReadonlyMap<string, HostTool>;
	done: boolean;
};

/** An MCP tool result that failed with `text`. */
function failed(text: string) {
	return { isError: true, content: [{ type: "text" as const, text }] };
}

/** Resolves once `signal` aborts. */
function aborted(signal: AbortSignal): Promise<undefined> {
	return new Promise(resolve => {
		if (signal.aborted) resolve(undefined);
		else signal.addEventListener("abort", () => resolve(undefined), { once: true });
	});
}

function delay(ms: number) {
	return new Promise<void>(resolve => setTimeout(resolve, ms));
}

/** `promise`'s value, or undefined when `signal` aborts first. */
function unlessAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T | undefined> {
	return Promise.race([promise, aborted(signal)]);
}

/** One Chopin Planner session and the agent that runs its turns. */
class PlannerSession {
	readonly #options: PlannerOptions;
	readonly #isolated: boolean;
	/** Every host tool a turn of this session offered; the agent lists them. */
	readonly #listed = new Map<string, HostTool>();
	readonly #calls = new Map<string, Known>();
	#prompt: Prompt | undefined;
	/** The instructions the agent has, and the latest any turn gave. */
	#sent: string | undefined;
	#latest: string | undefined;
	#agent: Promise<Agent> | undefined;
	/** The agent still starting, so closing can stop it at once. */
	#starting: { stop(): Promise<void> } | undefined;
	/** Turns run one at a time, each once the previous prompt has settled or its agent stopped. */
	#queue: Promise<void> = Promise.resolve();
	#workdir: string | undefined;
	#mcp: ReturnType<typeof serveLocalBridge> | undefined;
	#closing: Promise<void> | undefined;
	#modelNoted = false;

	constructor(readonly id: string, mode: "planner" | "isolated", options: PlannerOptions) {
		this.#options = options;
		this.#isolated = mode === "isolated";
	}

	async run(context: TurnContext): Promise<void> {
		let previous = this.#queue;
		let release!: () => void;
		this.#queue = new Promise(resolve => {
			release = resolve;
		});
		let settled: Promise<void> = Promise.resolve();
		let prompt: Prompt | undefined;
		try {
			await unlessAborted(previous, context.signal);
			for (let tool of context.message.tools) this.#listed.set(tool.name, tool);
			let agent = await unlessAborted(this.#ready(), context.signal);
			if (!agent || context.signal.aborted) return;
			let format = context.message.responseFormat?.type === "json"
				? context.message.responseFormat
				: undefined;
			prompt = {
				context,
				stream: streamer(part => context.emit(part), !!format),
				tools: new Map(context.message.tools.map(tool => [tool.name, tool])),
				done: false,
			};
			this.#prompt = prompt;
			if (context.message.model && !this.#modelNoted) {
				this.#modelNoted = true;
				this.#options.log(
					`Chopin asked for ${context.message.model}; the agent uses its own model.`,
				);
			}
			let instructions = context.message.instructions ?? this.#latest;
			let text = promptText({ ...context.message, instructions }, this.#sent);
			this.#latest = this.#sent = instructions;
			context.emit({ type: "stream-start" });
			let prompting = agent.connection.agent.request("session/prompt", {
				sessionId: agent.sessionId,
				prompt: [{ type: "text", text }],
			});
			let current = prompt;
			let cancel = () => {
				current.done = true;
				agent.cancel();
			};
			context.signal.addEventListener("abort", cancel, { once: true });
			if (context.signal.aborted) cancel();
			settled = this.#settle(prompting, agent, context.signal);
			let response;
			try {
				response = await unlessAborted(prompting, context.signal);
			} finally {
				context.signal.removeEventListener("abort", cancel);
			}
			if (!response) return;
			if (response.stopReason === "cancelled") throw new Error("The agent cancelled the turn.");
			prompt.stream.finish(format);
			let finishReason = {
				unified: FINISH[response.stopReason] ?? "other",
				raw: response.stopReason,
			};
			let used = usage(response.usage);
			context.emit({ type: "finish-step", finishReason, usage: used });
			context.emit({ type: "finish", finishReason, totalUsage: used });
		} finally {
			if (prompt) prompt.done = true;
			if (this.#prompt === prompt) this.#prompt = undefined;
			void settled.finally(release);
		}
	}

	/** Resolves once the prompt settles; after a cancel, stops an agent that takes too long. */
	async #settle(prompting: Promise<unknown>, agent: Agent, signal: AbortSignal): Promise<void> {
		let done = prompting.then(() => true, () => true);
		if (await Promise.race([done, aborted(signal)])) return;
		let limit = this.#options.windDownMs ?? WIND_DOWN_MS;
		if (await Promise.race([done, delay(limit).then(() => false)])) return;
		this.#options.log(`The agent kept working ${limit / 1000}s after a cancel, so it was stopped.`);
		if (await this.#agent?.catch(() => undefined) === agent) this.#agent = undefined;
		await agent.stop();
	}

	/** The running agent; a fresh one when it has not started, failed to, or exited. */
	async #ready(): Promise<Agent> {
		let current = await this.#agent?.catch(() => undefined);
		if (current && !current.connection.signal.aborted) return current;
		// An agent whose connection broke may still be running, or its children may.
		await current?.stop();
		this.#agent = this.#start();
		return this.#agent;
	}

	/** Where the agent works: the checkout, or for an isolated session an empty directory. */
	#cwd(): string {
		if (!this.#isolated) return this.#options.cwd;
		this.#workdir ??= mkdtempSync(join(tmpdir(), "chopin-acp-planner-"));
		return this.#workdir;
	}

	/** Remembers what `tool_call` updates say, for permission requests that name a call by id. */
	#track(update: SessionNotification["update"]) {
		if (update.sessionUpdate !== "tool_call" && update.sessionUpdate !== "tool_call_update") return;
		let known = this.#calls.get(update.toolCallId) ?? {};
		this.#calls.delete(update.toolCallId);
		this.#calls.set(update.toolCallId, {
			kind: update.kind ?? known.kind,
			title: update.title ?? known.title,
			locations: update.locations ?? known.locations,
		});
		if (this.#calls.size > 1_000) this.#calls.delete(this.#calls.keys().next().value!);
	}

	/** The agent, with the `chopin` MCP server, in a fresh conversation. */
	async #start(): Promise<Agent> {
		if (this.#closing) throw new Error("The Planner session has ended.");
		this.#sent = undefined;
		let cwd = this.#cwd();
		this.#mcp ??= serveLocalBridge(async () => this.#server(), { untimed: true });
		let mcp = this.#mcp;
		let policy = { allow: this.#options.allow, decline: this.#options.decline };
		let app = new ClientApp()
			.onNotification("session/update", ({ params }) => {
				this.#track(params.update);
				let prompt = this.#prompt;
				if (prompt && !prompt.done) prompt.stream.update(params.update);
			})
			.onRequest("session/request_permission", async ({ params }) => {
				let prompt = this.#prompt;
				return permission(params, {
					...policy,
					cwd: this.#isolated ? undefined : cwd,
					tools: prompt && !prompt.done ? prompt.tools : new Map(),
				}, this.#calls.get(params.toolCall.toolCallId));
			});
		let started = startAgent(app, this.#options.command, cwd, this.#options.env, chunk => {
			for (let line of chunk.split("\n")) if (line.trim()) this.#options.log(`agent: ${line}`);
		});
		this.#starting = started;
		let timer = setTimeout(
			() => started.connection.close(new Error("The ACP agent did not start in time.")),
			START_MS,
		);
		try {
			let initialized = await initialize(started.connection);
			if (initialized.protocolVersion !== PROTOCOL_VERSION) {
				throw new Error(`The ACP agent speaks protocol ${initialized.protocolVersion}.`);
			}
			let http = initialized.agentCapabilities?.mcpCapabilities?.http === true;
			let proxy = this.#options.proxy
				?? bridgeCommand(undefined, undefined, undefined, "acp-planner-mcp");
			let server: McpServer = http
				? {
					type: "http",
					name: MCP_SERVER,
					url: mcp.url,
					headers: [{ name: "Authorization", value: `Bearer ${mcp.token}` }],
				}
				: {
					name: MCP_SERVER,
					...proxy,
					env: [
						{ name: MCP_URL_VARIABLE, value: mcp.url },
						{ name: MCP_TOKEN_VARIABLE, value: mcp.token },
					],
				};
			let session = await started.connection.agent.request("session/new", {
				cwd,
				mcpServers: [server],
			});
			let closeable = initialized.agentCapabilities?.sessionCapabilities?.close != null;
			this.#options.log(`Started the agent for Planner session ${this.id}.`);
			return {
				connection: started.connection,
				sessionId: session.sessionId,
				cancel: () =>
					void started.connection.agent.notify("session/cancel", { sessionId: session.sessionId })
						.catch(() => {}),
				stop: async () => {
					if (closeable && !started.connection.signal.aborted) {
						await Promise.race([
							started.connection.agent.request("session/close", { sessionId: session.sessionId })
								.catch(() => {}),
							delay(CLOSE_MS),
						]);
					}
					await started.stop();
				},
			};
		} catch (error) {
			let failure = await started.failure(error);
			await started.stop();
			// What the agent printed stays here: a turn's error is shown to everyone in Chat.
			this.#options.log(
				`The ACP agent did not start (${failure.how}${
					failure.stderr ? `: ${failure.stderr}` : ""
				}).`,
			);
			throw new Error("The ACP agent did not start; the acp-planner output says why.", {
				cause: error,
			});
		} finally {
			clearTimeout(timer);
			if (this.#starting === started) this.#starting = undefined;
		}
	}

	/** Chopin's host tools as an MCP server; a call runs in the turn whose prompt is in flight. */
	#server(): Server {
		let server = new Server({ name: MCP_SERVER, version: VERSION }, {
			capabilities: { tools: {} },
		});
		server.setRequestHandler(ListToolsRequestSchema, () => ({
			tools: [...this.#listed.values()].map(tool => ({
				name: tool.name,
				...(tool.description === undefined ? {} : { description: tool.description }),
				inputSchema: { ...tool.inputSchema, type: "object" as const },
			})),
		}));
		server.setRequestHandler(CallToolRequestSchema, async request => {
			let prompt = this.#prompt;
			let name = request.params.name;
			if (!prompt || prompt.done || prompt.context.signal.aborted) {
				return failed("No Chopin turn is running, so Chopin's tools are unavailable.");
			}
			if (!prompt.tools.has(name)) return failed(`Chopin does not offer ${name} in this turn.`);
			let result = await prompt.context.callHostTool(name, request.params.arguments ?? {});
			return {
				...(result.isError ? { isError: true } : {}),
				// Chopin's tools mostly answer with JSON text already; pass that on as it is.
				content: [{
					type: "text" as const,
					text: typeof result.output === "string" ? result.output : JSON.stringify(result.output),
				}],
			};
		});
		return server;
	}

	close(): Promise<void> {
		return this.#closing ??= (async () => {
			if (this.#prompt) this.#prompt.done = true;
			await this.#starting?.stop();
			let agent = await this.#agent?.catch(() => undefined);
			await agent?.stop();
			this.#mcp?.close();
			if (this.#workdir) rmSync(this.#workdir, { recursive: true, force: true });
		})();
	}
}

/**
 * Attach to the document as its Planner and serve its sessions until the link closes, then stop
 * every agent. Throws `AgentRefused` when Chopin refuses the attachment.
 */
export async function runAcpPlanner(options: PlannerOptions): Promise<LinkClosed> {
	let sessions = new Map<string, PlannerSession>();
	let closing = new Set<Promise<void>>();
	let client = await (options.connect ?? connectAgent)({
		url: options.url,
		token: options.token,
		document: options.document,
		...(options.checkout ? { checkout: options.checkout } : {}),
		handlers: {
			start(message) {
				sessions.set(message.session, new PlannerSession(message.session, message.mode, options));
			},
			turn(context) {
				let session = sessions.get(context.message.session);
				if (!session) throw new Error("This Planner session was not started.");
				return session.run(context);
			},
			destroy(message) {
				let session = sessions.get(message.session);
				sessions.delete(message.session);
				if (session) closing.add(session.close());
			},
		},
	});
	let document = client.document;
	options.log(
		`Attached as the Planner of "${document.title}" (${
			document.url ?? document.id
		}) in ${document.repository}.`,
	);
	let stopAll = () => {
		for (let session of sessions.values()) closing.add(session.close());
	};
	// Detaching stops every agent at once: the connector kills a backend 5 seconds after asking.
	let detach = () => {
		void client.detach();
		stopAll();
	};
	options.signal?.addEventListener("abort", detach, { once: true });
	if (options.signal?.aborted) detach();
	try {
		return await Promise.race([
			client.closed,
			options.signal
				? aborted(options.signal).then(() => delay(DETACH_MS)).then(() => ({
					code: 1000,
					reason: "",
				}))
				: new Promise<never>(() => {}),
		]);
	} finally {
		options.signal?.removeEventListener("abort", detach);
		stopAll();
		await Promise.allSettled(closing);
	}
}

/**
 * `chopin acp-planner-mcp`: the `chopin` MCP server over stdio, for an agent that takes no HTTP
 * servers. Every line is one JSON-RPC message, forwarded to the bridge's loopback endpoint; calls
 * run concurrently, so a long one, such as a question waiting on Decisions, holds up no other.
 */
export async function plannerMcpProxy(
	env: NodeJS.ProcessEnv = process.env,
	input: NodeJS.ReadableStream = process.stdin,
	output: { write(text: string): unknown } = process.stdout,
): Promise<void> {
	let url = env[MCP_URL_VARIABLE];
	let token = env[MCP_TOKEN_VARIABLE];
	if (!url || !token) {
		throw new Error(`${MCP_URL_VARIABLE} and ${MCP_TOKEN_VARIABLE} are required.`);
	}
	let pending = new Set<Promise<void>>();
	for await (let line of createInterface({ input, crlfDelay: Infinity })) {
		if (!line.trim()) continue;
		let id: unknown;
		try {
			id = (JSON.parse(line) as { id?: unknown }).id;
		} catch {
			continue;
		}
		let forward = (async () => {
			let text: string;
			try {
				let response = await fetch(url, {
					method: "POST",
					headers: {
						authorization: `Bearer ${token}`,
						"content-type": "application/json",
						accept: "application/json, text/event-stream",
					},
					body: line,
				});
				text = (await response.text()).trim();
				if (!response.ok && id !== undefined && !text) throw new Error(`HTTP ${response.status}`);
			} catch (error) {
				if (id === undefined) return;
				text = JSON.stringify({
					jsonrpc: "2.0",
					id,
					error: { code: -32603, message: error instanceof Error ? error.message : String(error) },
				});
			}
			if (text) output.write(`${text}\n`);
		})();
		pending.add(forward);
		void forward.finally(() => pending.delete(forward));
	}
	await Promise.allSettled(pending);
}

const run = promisify(execFile);

/** Git's output, "" when it printed nothing, or undefined when it failed. */
async function git(cwd: string, env: NodeJS.ProcessEnv, ...args: string[]) {
	try {
		return (await run("git", ["-C", cwd, ...args], { env, timeout: 60_000 })).stdout.trim();
	} catch {
		return undefined;
	}
}

/** An origin URL without credentials, or undefined when it cannot be read as one. */
export function bareOrigin(origin: string): string | undefined {
	if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(origin)) {
		// An scp-style `git@host:owner/repo` names a user, never a secret; anything else is unclear.
		return !origin.includes("@") || /^[\w.-]+@[\w.-]+:/.test(origin) ? origin : undefined;
	}
	try {
		let url = new URL(origin);
		url.username = "";
		url.password = "";
		return url.href;
	} catch {
		return undefined;
	}
}

/** What `attach` says about the checkout, with any credentials in the origin URL left out. */
export async function checkoutInfo(
	cwd: string,
	env: NodeJS.ProcessEnv = process.env,
): Promise<NonNullable<AgentOptions["checkout"]>> {
	let [origin, branch, head] = await Promise.all([
		git(cwd, env, "remote", "get-url", "origin"),
		git(cwd, env, "rev-parse", "--abbrev-ref", "HEAD"),
		git(cwd, env, "rev-parse", "HEAD"),
	]);
	let bare = origin ? bareOrigin(origin) : undefined;
	return {
		...(bare && bare.length <= 2048 ? { origin: bare } : {}),
		...(branch && branch.length <= 256 ? { branch } : {}),
		...(head && head.length <= 128 ? { head } : {}),
	};
}

/**
 * Where a Planner command's agent works: its own worktree at CHOPIN_WORKTREE, detached at the
 * checkout's commit and moved there again at each launch while it has no changes; the checkout
 * itself when no worktree can be added.
 */
export async function plannerCheckout(
	checkout: string | undefined,
	worktree: string | undefined,
	env: NodeJS.ProcessEnv,
	log: (line: string) => void,
): Promise<string> {
	if (!checkout) throw new Error("CHOPIN_CHECKOUT is missing.");
	if (!worktree) return checkout;
	let head = await git(checkout, env, "rev-parse", "HEAD");
	if (existsSync(worktree)) {
		if (head && await git(worktree, env, "status", "--porcelain") === "") {
			await git(worktree, env, "checkout", "--quiet", "--detach", head);
		}
		return worktree;
	}
	try {
		await run("git", ["-C", checkout, "worktree", "add", "--quiet", "--detach", worktree], {
			env,
			timeout: 120_000,
		});
		return worktree;
	} catch (error) {
		log(
			`Could not add the Planner's worktree at ${worktree} (${
				error instanceof Error ? error.message.split("\n")[0] : error
			}), so the agent works in ${checkout}.`,
		);
		return checkout;
	}
}

/** GH_TOKEN, else GITHUB_TOKEN, else the GitHub CLI's login. */
export async function githubBearer(env: NodeJS.ProcessEnv): Promise<string> {
	let token = env.GH_TOKEN || env.GITHUB_TOKEN;
	if (token) return token;
	try {
		token =
			(await run("gh", ["auth", "token", "--hostname", "github.com"], { env, timeout: 10_000 }))
				.stdout.trim();
	} catch {
		token = "";
	}
	if (!token) {
		throw new Error(
			"No GitHub token to attach with: set GH_TOKEN, or sign in with `gh auth login`.",
		);
	}
	return token;
}

/** Why Chopin closed an attached link, as the close codes in docs/agent-connection.md say. */
const CLOSED: Record<number, string> = {
	4401: "the Chopin browser sign-in this Planner rests on ended; sign in to Chopin in a browser as "
		+ "the same GitHub account, then run this again",
	4403: "this account lost access, or someone reset or moved the document's Planner",
	4404: "the document is unavailable or archived",
	4409: "another client holds the document's Planner",
};

/**
 * Whether attaching again can succeed after a link closed or an attach failed: a drop, an
 * unresponsive or unavailable server, a server that cannot be reached once this Planner had
 * attached (it may be restarting), or this Planner's own dropped connection still counted.
 */
export function retryable(
	outcome: { closed: LinkClosed } | { error: unknown },
	attached: boolean,
): boolean {
	if ("closed" in outcome) return [1001, 1006, 1011].includes(outcome.closed.code);
	let error = outcome.error;
	if (error instanceof AgentRefused) {
		return error.code === "unavailable" || attached && error.code === "planner-attached";
	}
	return attached;
}

function sleep(ms: number, signal: AbortSignal) {
	return new Promise<void>(done => {
		let finish = () => {
			clearTimeout(timer);
			signal.removeEventListener("abort", finish);
			done();
		};
		let timer = setTimeout(finish, ms);
		signal.addEventListener("abort", finish, { once: true });
	});
}

const log = (line: string) => console.error(`acp-planner: ${line}`);

const USAGE = `Usage: ${SELF} acp-planner [--document <document URL or id>] [--checkout <dir>] `
	+ "[--allow read|all] [--decline reject|cancel] -- <ACP agent command>";

/**
 * `chopin acp-planner`. Started by `chopin connect --planner-command` it attaches once with the
 * credential it is given and exits when the link closes, for the connector to start it again.
 * Run by hand it attaches with the user's own GitHub token and attaches again after a drop.
 */
export async function acpPlannerCommand(
	args: string[],
	deps: {
		server(): Promise<{ origin: string }>;
		origin(value: string): string;
		usage(text: string): Error;
	},
): Promise<void> {
	let parsed = parseArgs(args, { options: ["document", "checkout", "allow", "decline"] });
	let command = parsed.rest ?? [];
	let allow = parsed.options.get("allow") ?? "read";
	let decline = parsed.options.get("decline") ?? "reject";
	if (
		!command.length || parsed.positional.length || allow !== "read" && allow !== "all"
		|| decline !== "reject" && decline !== "cancel"
	) throw deps.usage(USAGE);
	let stop = new AbortController();
	let quit = () => stop.abort();
	process.once("SIGTERM", quit);
	process.once("SIGINT", quit);
	// Neither the agent nor git ever sees the Planner credential.
	let { CHOPIN_PLANNER_TOKEN: credential, ...env } = process.env;
	let base = { command, env, allow, decline, log, signal: stop.signal } as const;
	let ended = (closed: LinkClosed) =>
		new Error(
			`The agent connection closed (${closed.code}${closed.reason ? ` ${closed.reason}` : ""})${
				CLOSED[closed.code] ? `: ${CLOSED[closed.code]}` : ""
			}.`,
		);
	if (credential) {
		if (parsed.options.has("checkout")) {
			throw deps.usage(`${USAGE}\n--checkout is chopin connect's to give a Planner command.`);
		}
		if (!process.env.CHOPIN_URL) throw new Error("CHOPIN_URL is missing.");
		let document = parsed.options.get("document") ?? process.env.CHOPIN_DOCUMENT;
		if (!document) throw new Error("CHOPIN_DOCUMENT is missing.");
		let cwd = await plannerCheckout(
			process.env.CHOPIN_CHECKOUT,
			process.env.CHOPIN_WORKTREE,
			env,
			log,
		);
		let closed = await runAcpPlanner({
			...base,
			url: deps.origin(process.env.CHOPIN_URL),
			token: credential,
			document,
			cwd,
			checkout: await checkoutInfo(cwd, env),
		});
		if (!stop.signal.aborted) throw ended(closed);
		return;
	}
	let document = parsed.options.get("document");
	if (!document) {
		throw deps.usage(
			`${USAGE}\n--document is required unless chopin connect started this as a Planner command.`,
		);
	}
	let url = (await deps.server()).origin;
	let cwd = resolve(parsed.options.get("checkout") ?? process.cwd());
	let options = {
		...base,
		url,
		token: await githubBearer(env),
		document,
		cwd,
		checkout: await checkoutInfo(cwd, env),
	};
	let delay = 1_000;
	for (let attached = false; !stop.signal.aborted;) {
		let since = Date.now();
		let outcome: { closed: LinkClosed } | { error: unknown };
		try {
			outcome = { closed: await runAcpPlanner(options) };
			attached = true;
		} catch (error) {
			outcome = { error };
		}
		if (stop.signal.aborted) return;
		if (!retryable(outcome, attached)) {
			if ("closed" in outcome) throw ended(outcome.closed);
			let error = outcome.error;
			throw error instanceof AgentRefused || attached
				? error
				: new Error(
					`${error instanceof Error ? error.message : error} Check that ${url} runs `
						+ "HARNESS=remote with AGENT on and that your GitHub token can push to the "
						+ "document's repository.",
				);
		}
		if (Date.now() - since > 60_000) delay = 1_000;
		log(`Attaching again in ${delay / 1000}s.`);
		await sleep(delay, stop.signal);
		delay = Math.min(delay * 2, 30_000);
	}
}
