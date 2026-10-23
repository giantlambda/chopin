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
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import { ClientApp } from "@agentclientprotocol/sdk";
import type {
	McpServer,
	RequestPermissionRequest,
	RequestPermissionResponse,
	SessionNotification,
	StopReason,
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
const EMPTY_USAGE = { inputTokens: {}, outputTokens: {} };
const FINISH: Partial<Record<StopReason, "stop" | "length" | "content-filter" | "other">> = {
	end_turn: "stop",
	max_tokens: "length",
	max_turn_requests: "length",
	refusal: "content-filter",
};
/** Tool kinds a Planner may use without asking: it reads and searches, it does not change code. */
const READ_KINDS = new Set(["read", "search", "fetch", "think"]);

type Turn = ServerMessageOf<"turn">;
type HostTool = Turn["tools"][number];
type Format = Extract<NonNullable<Turn["responseFormat"]>, { type: "json" }>;

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
	/** `read` allows read and search tools and Chopin's own; `all` allows every request. */
	allow: "read" | "all";
	log(line: string): void;
	/** Detaches when aborted. */
	signal?: AbortSignal;
	/** Tests replace the agent connection. */
	connect?: (options: AgentOptions) => Promise<AgentClient>;
	/** How an agent without HTTP MCP starts the stdio proxy; this chopin's own by default. */
	proxy?: { command: string; args: string[] };
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

/** Whether a permission request is for one of Chopin's tools, as agents title MCP calls. */
function chopinTool(title: string | null | undefined, tools: ReadonlyMap<string, HostTool>) {
	if (!title) return false;
	let name = title.replace(/^(mcp__chopin__|chopin[:/.]\s*)/, "");
	return name !== title && tools.has(name) || tools.has(title);
}

/** Answers an agent's permission request without asking anyone. */
export function permission(
	request: RequestPermissionRequest,
	allow: PlannerOptions["allow"],
	tools: ReadonlyMap<string, HostTool>,
): RequestPermissionResponse {
	let call = request.toolCall;
	let allowed = allow === "all" || READ_KINDS.has(call.kind ?? "") || chopinTool(call.title, tools);
	let option = allowed
		? request.options.find(item => item.kind === "allow_once")
			?? request.options.find(item => item.kind === "allow_always")
		: undefined;
	// A decline is `cancelled`, not a rejection: herdr-acp --unanswered herdr then leaves the
	// dialog for someone to answer in herdr.
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
		emit({ type: `${type}-delta`, id: open.id, delta });
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

type Agent = {
	connection: ReturnType<typeof startAgent>["connection"];
	sessionId: string;
	cancel(): void;
	stop(): Promise<void>;
};

/** An MCP tool result that failed with `text`. */
function failed(text: string) {
	return { isError: true, content: [{ type: "text" as const, text }] };
}

/** Resolves once `signal` aborts. */
function aborted(signal: AbortSignal): Promise<"cancelled"> {
	return new Promise(resolve => {
		if (signal.aborted) resolve("cancelled");
		else signal.addEventListener("abort", () => resolve("cancelled"), { once: true });
	});
}

/** One Chopin Planner session and the agent that runs its turns. */
class PlannerSession {
	readonly #options: PlannerOptions;
	/** Every host tool a turn of this session offered; the agent lists them all. */
	readonly tools = new Map<string, HostTool>();
	#turn: TurnContext | undefined;
	#update: ((update: SessionNotification["update"]) => void) | undefined;
	#instructions: string | undefined;
	#agent: Promise<Agent> | undefined;
	/** The last prompt, which may still be winding down after its turn was aborted. */
	#settling: Promise<unknown> = Promise.resolve();
	#mcp: ReturnType<typeof serveLocalBridge> | undefined;
	#closed = false;

	constructor(readonly id: string, options: PlannerOptions) {
		this.#options = options;
	}

	async run(context: TurnContext): Promise<void> {
		for (let tool of context.message.tools) this.tools.set(tool.name, tool);
		this.#turn = context;
		try {
			let previous = this.#settling;
			await previous;
			let agent = await this.#ready();
			let format = context.message.responseFormat?.type === "json"
				? context.message.responseFormat
				: undefined;
			let stream = streamer(part => context.emit(part), !!format);
			this.#update = update => stream.update(update);
			let cancel = () => agent.cancel();
			context.signal.addEventListener("abort", cancel, { once: true });
			context.emit({ type: "stream-start" });
			let text = promptText(context.message, this.#instructions);
			this.#instructions = context.message.instructions ?? this.#instructions;
			let reason: StopReason;
			try {
				let prompting = agent.connection.agent.request("session/prompt", {
					sessionId: agent.sessionId,
					prompt: [{ type: "text", text }],
				});
				this.#settling = prompting.catch(() => {});
				// An aborted turn ends at once; the next turn waits for the agent to wind down.
				reason = await Promise.race([
					prompting.then(response => response.stopReason),
					aborted(context.signal),
				]);
			} finally {
				context.signal.removeEventListener("abort", cancel);
				this.#update = undefined;
			}
			if (context.signal.aborted) return;
			if (reason === "cancelled") throw new Error("The agent cancelled the turn.");
			stream.finish(format);
			let finishReason = { unified: FINISH[reason] ?? "other", raw: reason } as const;
			context.emit({ type: "finish-step", finishReason, usage: EMPTY_USAGE });
			context.emit({ type: "finish", finishReason, totalUsage: EMPTY_USAGE });
		} finally {
			this.#turn = undefined;
		}
	}

	/** The running agent; a fresh one when it has not started, failed to, or exited. */
	async #ready(): Promise<Agent> {
		let agent = await this.#agent?.catch(() => undefined);
		if (agent && !agent.connection.signal.aborted) return agent;
		this.#agent = this.#start();
		return this.#agent;
	}

	/** The agent, with the `chopin` MCP server, in a fresh conversation. */
	async #start(): Promise<Agent> {
		if (this.#closed) throw new Error("The Planner session has ended.");
		this.#instructions = undefined;
		this.#mcp ??= serveLocalBridge(async () => this.#server());
		let mcp = this.#mcp;
		let app = new ClientApp()
			.onNotification("session/update", ({ params }) => this.#update?.(params.update))
			.onRequest(
				"session/request_permission",
				async ({ params }) =>
					this.#turn
						? permission(params, this.#options.allow, this.tools)
						: { outcome: { outcome: "cancelled" as const } },
			);
		let started = startAgent(
			app,
			this.#options.command,
			this.#options.cwd,
			this.#options.env,
			chunk => {
				for (let line of chunk.split("\n")) if (line.trim()) this.#options.log(`agent: ${line}`);
			},
		);
		let timer = setTimeout(
			() => started.connection.close(new Error("The ACP agent did not start in time.")),
			START_MS,
		);
		try {
			let initialized = await initialize(started.connection);
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
				cwd: this.#options.cwd,
				mcpServers: [server],
			});
			let closeable = initialized.agentCapabilities?.sessionCapabilities?.close !== undefined;
			let agent: Agent = {
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
							new Promise(resolve => setTimeout(resolve, 5_000)),
						]);
					}
					await started.stop();
				},
			};
			this.#options.log(`Started the agent for Planner session ${this.id}.`);
			return agent;
		} catch (error) {
			let failure = await started.failure(error);
			await started.stop();
			throw new Error(
				`The ACP agent did not start (${failure.how}${
					failure.stderr ? `: ${failure.stderr}` : ""
				}).`,
				{ cause: error },
			);
		} finally {
			clearTimeout(timer);
		}
	}

	/** Chopin's host tools as an MCP server; a call runs in the turn that is running now. */
	#server(): Server {
		let server = new Server({ name: MCP_SERVER, version: VERSION }, {
			capabilities: { tools: {} },
		});
		server.setRequestHandler(ListToolsRequestSchema, () => ({
			tools: [...this.tools.values()].map(tool => ({
				name: tool.name,
				...(tool.description === undefined ? {} : { description: tool.description }),
				inputSchema: (tool.inputSchema ?? { type: "object" }) as { type: "object" },
			})),
		}));
		server.setRequestHandler(CallToolRequestSchema, async request => {
			let turn = this.#turn;
			let name = request.params.name;
			if (!turn || turn.signal.aborted) {
				return failed("No Chopin turn is running, so Chopin's tools are unavailable.");
			}
			if (!turn.message.tools.some(tool => tool.name === name)) {
				return failed(`Chopin does not offer ${name} in this turn.`);
			}
			let result = await turn.callHostTool(name, request.params.arguments ?? {});
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

	async close(): Promise<void> {
		this.#closed = true;
		let agent = await this.#agent?.catch(() => undefined);
		await agent?.stop();
		this.#mcp?.close();
	}
}

/**
 * Attach to the document as its Planner and serve its sessions until the link closes, then stop
 * every agent. Throws `AgentRefused` when Chopin refuses the attachment.
 */
export async function runAcpPlanner(options: PlannerOptions): Promise<LinkClosed> {
	let sessions = new Map<string, PlannerSession>();
	let client = await (options.connect ?? connectAgent)({
		url: options.url,
		token: options.token,
		document: options.document,
		...(options.checkout ? { checkout: options.checkout } : {}),
		handlers: {
			start(message) {
				sessions.set(message.session, new PlannerSession(message.session, options));
			},
			turn(context) {
				let session = sessions.get(context.message.session);
				if (!session) throw new Error("This Planner session was not started.");
				return session.run(context);
			},
			destroy(message) {
				let session = sessions.get(message.session);
				sessions.delete(message.session);
				void session?.close();
			},
		},
	});
	let document = client.document;
	options.log(
		`Attached as the Planner of "${document.title}" (${
			document.url ?? document.id
		}) in ${document.repository}.`,
	);
	let detach = () => void client.detach();
	options.signal?.addEventListener("abort", detach, { once: true });
	if (options.signal?.aborted) detach();
	try {
		return await client.closed;
	} finally {
		options.signal?.removeEventListener("abort", detach);
		await Promise.allSettled([...sessions.values()].map(session => session.close()));
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

async function git(cwd: string, ...args: string[]): Promise<string | undefined> {
	try {
		return (await run("git", ["-C", cwd, ...args], { timeout: 60_000 })).stdout.trim() || undefined;
	} catch {
		return undefined;
	}
}

/** What `attach` says about the checkout, with any credentials in the origin URL left out. */
export async function checkoutInfo(cwd: string): Promise<NonNullable<AgentOptions["checkout"]>> {
	let [origin, branch, head] = await Promise.all([
		git(cwd, "remote", "get-url", "origin"),
		git(cwd, "rev-parse", "--abbrev-ref", "HEAD"),
		git(cwd, "rev-parse", "HEAD"),
	]);
	let bare = origin?.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/@]*@/i, "$1");
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
	log: (line: string) => void,
): Promise<string> {
	if (!checkout) throw new Error("CHOPIN_CHECKOUT is missing.");
	if (!worktree) return checkout;
	let head = await git(checkout, "rev-parse", "HEAD");
	if (existsSync(worktree)) {
		if (head && await git(worktree, "status", "--porcelain") === undefined) {
			await git(worktree, "checkout", "--quiet", "--detach", head);
		}
		return worktree;
	}
	try {
		await run("git", ["-C", checkout, "worktree", "add", "--quiet", "--detach", worktree], {
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
		token = (await run("gh", ["auth", "token", "--hostname", "github.com"], { timeout: 10_000 }))
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
/** Close codes after which attaching again can succeed: dropped, unresponsive, or unavailable. */
const RETRY = new Set([1001, 1006, 1011]);

function sleep(ms: number, signal: AbortSignal) {
	return new Promise<void>(done => {
		let timer = setTimeout(done, ms);
		signal.addEventListener("abort", () => {
			clearTimeout(timer);
			done();
		}, { once: true });
	});
}

const log = (line: string) => console.error(`acp-planner: ${line}`);

const USAGE = `Usage: ${SELF} acp-planner [--document <document URL or id>] [--checkout <dir>] `
	+ "[--allow read|all] -- <ACP agent command>";

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
	let parsed = parseArgs(args, { options: ["document", "checkout", "allow"] });
	let command = parsed.rest ?? [];
	let allow = parsed.options.get("allow") ?? "read";
	if (!command.length || parsed.positional.length || allow !== "read" && allow !== "all") {
		throw deps.usage(USAGE);
	}
	let stop = new AbortController();
	let quit = () => stop.abort();
	process.once("SIGTERM", quit);
	process.once("SIGINT", quit);
	// The agent never sees the Planner credential.
	let { CHOPIN_PLANNER_TOKEN: credential, ...env } = process.env;
	let base = { command, env, allow, log, signal: stop.signal } as const;
	let ended = (closed: LinkClosed) =>
		new Error(
			`The agent connection closed (${closed.code}${closed.reason ? ` ${closed.reason}` : ""})${
				CLOSED[closed.code] ? `: ${CLOSED[closed.code]}` : ""
			}.`,
		);
	if (credential) {
		let document = parsed.options.get("document") ?? process.env.CHOPIN_DOCUMENT;
		if (!document) throw new Error("CHOPIN_DOCUMENT is missing.");
		let cwd = await plannerCheckout(process.env.CHOPIN_CHECKOUT, process.env.CHOPIN_WORKTREE, log);
		let closed = await runAcpPlanner({
			...base,
			url: deps.origin(process.env.CHOPIN_URL ?? ""),
			token: credential,
			document,
			cwd,
			checkout: await checkoutInfo(cwd),
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
		checkout: await checkoutInfo(cwd),
	};
	let delay = 1_000;
	for (let attached = false; !stop.signal.aborted;) {
		let since = Date.now();
		let closed: LinkClosed;
		try {
			closed = await runAcpPlanner(options);
			attached = true;
		} catch (error) {
			// Reattaching can find this Planner's own dropped connection still counted for a while.
			if (!(error instanceof AgentRefused && error.code === "planner-attached" && attached)) {
				throw error instanceof AgentRefused || attached
					? error
					: new Error(
						`${error instanceof Error ? error.message : error} Check that ${url} runs `
							+ "HARNESS=remote with AGENT on and that your GitHub token can push to the "
							+ "document's repository.",
					);
			}
			closed = { code: 4409, reason: "" };
		}
		if (stop.signal.aborted) return;
		if (!RETRY.has(closed.code) && closed.code !== 4409) throw ended(closed);
		if (Date.now() - since > 60_000) delay = 1_000;
		log(`The agent connection closed (${closed.code}); attaching again in ${delay / 1000}s.`);
		await sleep(delay, stop.signal);
		delay = Math.min(delay * 2, 30_000);
	}
}
