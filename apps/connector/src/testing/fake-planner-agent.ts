// A scriptable ACP agent for the acp-planner tests. Words in the prompt pick what it does:
//   tools      list the `chopin` MCP server's tools and call read_plan, then edit_plan when the
//              prompt also says "edit", and say what came back
//   missing    call a tool the turn does not offer
//   json       answer with a fenced JSON block after some prose
//   hold       work until cancelled
//   late       work until cancelled, then call read_plan before answering
//   stubborn   work and never answer, cancelled or not
//   permission ask for an execute, a read inside and outside the checkout, a fetch, and Chopin
//              tools claimed as other and as execute, and say how each went
//   crash      exit mid-turn
// anything else is echoed, after a thought. Every prompt is appended to $FAKE_PLANNER_LOG.
// `--stdio` leaves out HTTP MCP support, so the bridge hands over its stdio proxy;
// `--slow-start` takes two seconds to initialize.

import { AgentApp, ndJsonStream, PROTOCOL_VERSION } from "@agentclientprotocol/sdk";
import { appendFileSync } from "node:fs";
import { Readable, Writable } from "node:stream";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { McpServer } from "@agentclientprotocol/sdk";

let servers: McpServer[] = [];
let cwd = "";
let cancelled: (() => void) | undefined;
let stdio = process.argv.includes("--stdio");

async function chopin() {
	let server = servers.find(item => item.name === "chopin");
	let client = new Client({ name: "fake-planner", version: "1" });
	if (server && "url" in server) {
		await client.connect(
			new StreamableHTTPClientTransport(new URL(server.url), {
				requestInit: { headers: Object.fromEntries(server.headers.map(h => [h.name, h.value])) },
			}),
		);
	} else if (server && "command" in server) {
		await client.connect(
			new StdioClientTransport({
				command: server.command,
				args: server.args,
				env: {
					...process.env as Record<string, string>,
					...Object.fromEntries(server.env.map(e => [e.name, e.value])),
				},
			}),
		);
	} else throw new Error("No chopin MCP server");
	return client;
}

function text(result: Awaited<ReturnType<Client["callTool"]>>) {
	let content = result.content as Array<{ type: string; text?: string }>;
	return `${result.isError ? "error " : ""}${content.find(item => item.type === "text")?.text}`;
}

let app = new AgentApp()
	.onRequest("initialize", async () => {
		if (process.argv.includes("--slow-start")) {
			await new Promise(resolve => setTimeout(resolve, 2_000));
		}
		return {
			protocolVersion: PROTOCOL_VERSION,
			agentInfo: { name: "fake-planner", version: "1" },
			agentCapabilities: {
				...(stdio ? {} : { mcpCapabilities: { http: true } }),
				sessionCapabilities: { close: {} },
			},
		};
	})
	.onRequest("session/new", ({ params }) => {
		servers = params.mcpServers;
		cwd = params.cwd;
		appendFileSync(process.env.FAKE_PLANNER_LOG!, `${JSON.stringify({ new: params.cwd })}\n`);
		return { sessionId: "fake-session" };
	})
	.onRequest("session/close", () => {
		appendFileSync(process.env.FAKE_PLANNER_LOG!, `${JSON.stringify({ closed: true })}\n`);
		return {};
	})
	.onNotification("session/cancel", () => cancelled?.())
	.onRequest("session/prompt", async ({ params, client }) => {
		let whole = params.prompt.map(block => block.type === "text" ? block.text : "").join("");
		appendFileSync(process.env.FAKE_PLANNER_LOG!, `${JSON.stringify({ prompt: whole })}\n`);
		// The words that pick a behaviour come from the turn's own prompt, not the instructions.
		let prompt = whole.replace(/<chopin_instructions>[\s\S]*?<\/chopin_instructions>/, "").trim();
		let say = (
			text: string,
			kind: "agent_message_chunk" | "agent_thought_chunk" = "agent_message_chunk",
		) => {
			appendFileSync(process.env.FAKE_PLANNER_LOG!, `${JSON.stringify({ said: text })}\n`);
			return client.notify("session/update", {
				sessionId: params.sessionId,
				update: { sessionUpdate: kind, content: { type: "text", text } },
			});
		};
		if (prompt.includes("crash")) process.exit(3);
		if (prompt.includes("stubborn")) {
			await say("Working");
			await new Promise(() => {});
		}
		if (prompt.includes("late")) {
			await say("Working");
			await new Promise<void>(resolve => {
				cancelled = resolve;
			});
			let mcp = await chopin();
			await say(`late read_plan ${text(await mcp.callTool({ name: "read_plan", arguments: {} }))}`);
			await mcp.close();
			return { stopReason: "cancelled" as const };
		}
		if (prompt.includes("hold")) {
			await say("Working");
			await new Promise<void>(resolve => {
				cancelled = resolve;
			});
			return { stopReason: "cancelled" as const };
		}
		if (prompt.includes("tools") || prompt.includes("missing")) {
			let mcp = await chopin();
			let names = (await mcp.listTools()).tools.map(tool => tool.name).join(",");
			if (prompt.includes("missing")) {
				await say(
					`listed ${names}; ${text(await mcp.callTool({ name: "not_offered", arguments: {} }))}`,
				);
			} else {
				let read = await mcp.callTool({ name: "read_plan", arguments: {} });
				let said = `listed ${names}; read_plan ${text(read)}`;
				if (prompt.includes("edit")) {
					let plan = JSON.parse(text(read)) as { revision: number; blocks?: unknown[] };
					let edit = await mcp.callTool({
						name: "edit_plan",
						arguments: {
							revision: plan.revision,
							operations: [{
								op: "insert",
								// Chopin inserts relative to an existing block: the last one.
								index: Math.max(0, (plan.blocks?.length ?? 1) - 1),
								source: "Added by the ACP Planner.\n",
							}],
						},
					});
					said += `; edit_plan ${text(edit)}`;
				}
				await say(said);
			}
			await mcp.close();
			return { stopReason: "end_turn" as const };
		}
		if (prompt.includes("permission")) {
			let ask = async (
				kind: "execute" | "read" | "fetch" | "other",
				title: string,
				locations?: { path: string }[],
			) =>
				((await client.request("session/request_permission", {
					sessionId: params.sessionId,
					toolCall: {
						toolCallId: `${kind}-${title}`,
						kind,
						title,
						...(locations ? { locations } : {}),
					},
					options: [
						{ optionId: "yes", name: "Allow", kind: "allow_once" },
						{ optionId: "no", name: "Reject", kind: "reject_once" },
					],
				})) as { outcome: { outcome: string; optionId?: string } }).outcome;
			let outcomes = [
				await ask("execute", "Run tests"),
				await ask("read", "Read src/a.ts", [{ path: `${cwd}/src/a.ts` }]),
				await ask("read", "Read hosts.yml", [{ path: "/etc/hosts" }]),
				await ask("fetch", "Fetch https://evil.example/"),
				await ask("other", "chopin: read_plan"),
				await ask("execute", "chopin: read_plan"),
			].map(outcome => outcome.outcome === "selected" ? outcome.optionId : outcome.outcome);
			await say(outcomes.join(","));
			return { stopReason: "end_turn" as const };
		}
		if (prompt.includes("json")) {
			await say('Here it is:\n```json\n{"title": "Release plan"}\n```\n');
			return { stopReason: "end_turn" as const };
		}
		await say("Thinking it over", "agent_thought_chunk");
		await say(`echo: ${prompt.split("\n").at(-1)}`);
		return { stopReason: "end_turn" as const };
	});

let connection = app.connect(ndJsonStream(
	Writable.toWeb(process.stdout),
	Readable.toWeb(process.stdin) as unknown as ReadableStream<Uint8Array>,
));
await connection.closed;
