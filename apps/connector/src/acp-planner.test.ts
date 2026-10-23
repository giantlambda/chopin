import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StreamPart } from "@chopin/agent-link";
import { AgentRefused } from "@chopin/agent-link/client";
import {
	bareOrigin,
	checkoutInfo,
	jsonReply,
	MCP_SERVER,
	permission,
	promptText,
	retryable,
	runAcpPlanner,
	streamer,
} from "./acp-planner";
import type { ServerWebSocket } from "bun";

const AGENT = join(import.meta.dir, "testing", "fake-planner-agent.ts");
const MAIN = join(import.meta.dir, "main.ts");
const TOOLS = [
	{
		name: "read_plan",
		description: "Read the plan.",
		inputSchema: { type: "object", properties: {} },
	},
	{
		name: "edit_plan",
		inputSchema: {
			type: "object",
			properties: { revision: { type: "integer" }, operations: { type: "array" } },
			required: ["revision", "operations"],
		},
	},
];

type Message = { type: string; [key: string]: unknown };

/**
 * The agent connection's server end, played by the test: it answers `attach`, runs host tools
 * with `host`, records everything else the client sends, and sends what the test asks it to.
 */
function fakeChopin(
	host: (name: string, input: unknown) => { output: unknown; isError?: boolean },
) {
	let received: Message[] = [];
	let wake: Array<() => void> = [];
	let socket: ServerWebSocket<unknown> | undefined;
	let server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch(request, server) {
			if (request.headers.get("authorization") !== "Bearer test-token") {
				return new Response(null, { status: 401 });
			}
			let upgraded = server.upgrade(request, {
				headers: { "sec-websocket-protocol": "chopin.agent.v1" },
			});
			return upgraded ? undefined : new Response(null, { status: 400 });
		},
		websocket: {
			open(ws) {
				socket = ws;
			},
			message(ws, data) {
				let message = JSON.parse(String(data)) as Message;
				if (message.type === "attach") {
					ws.send(JSON.stringify({
						type: "attached",
						version: 1,
						document: { id: "doc-1", title: "Release plan", repository: "octo-org/score" },
					}));
				}
				if (message.type === "detach") ws.close(1000);
				if (message.type === "host-tool-call") {
					let result = host(message.toolName as string, JSON.parse(message.input as string));
					ws.send(JSON.stringify({
						type: "host-tool-result",
						session: message.session,
						turn: message.turn,
						toolCallId: message.toolCallId,
						output: result.output,
						...(result.isError ? { isError: true } : {}),
					}));
				}
				received.push(message);
				for (let resume of wake.splice(0)) resume();
			},
		},
	});
	async function next(match: (message: Message) => boolean, timeout = 30_000) {
		let deadline = Date.now() + timeout;
		for (;;) {
			let found = received.find(match);
			if (found) return found;
			if (Date.now() > deadline) {
				throw new Error(`Timed out; got ${received.map(message => message.type).join(", ")}`);
			}
			await new Promise<void>(resolve => {
				wake.push(resolve);
				setTimeout(resolve, 100);
			});
		}
	}
	return {
		url: `http://127.0.0.1:${server.port}`,
		received,
		next,
		send: (message: Message) => socket!.send(JSON.stringify(message)),
		close: () => server.stop(true),
	};
}

let cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
	for (let step of cleanup.splice(0).toReversed()) await step();
});

/** A planner attached to a fake Chopin with session `s1` started, and a way to run turns. */
async function attached(
	options: {
		flags?: string[];
		allow?: "read" | "all";
		decline?: "reject" | "cancel";
		windDownMs?: number;
		command?: string[];
	} = {},
) {
	let chopin = fakeChopin((name, input) =>
		// Chopin's own tools answer with JSON text, which must reach the agent unescaped.
		name === "read_plan"
			? { output: JSON.stringify({ revision: 3, blocks: ["Intro"] }) }
			: { output: { ok: true, input } }
	);
	let dir = mkdtempSync(join(tmpdir(), "acp-planner-"));
	let log = join(dir, "agent.log");
	writeFileSync(log, "");
	let lines: string[] = [];
	let stop = new AbortController();
	let closed = runAcpPlanner({
		url: chopin.url,
		token: "test-token",
		document: "doc-1",
		command: options.command ?? ["bun", AGENT, ...options.flags ?? []],
		cwd: dir,
		env: { ...process.env, FAKE_PLANNER_LOG: log },
		allow: options.allow ?? "read",
		decline: options.decline ?? "reject",
		...(options.windDownMs ? { windDownMs: options.windDownMs } : {}),
		log: line => lines.push(line),
		signal: stop.signal,
		proxy: { command: process.execPath, args: [MAIN, "acp-planner-mcp"] },
	});
	cleanup.push(() => rmSync(dir, { recursive: true, force: true }), chopin.close, async () => {
		stop.abort();
		await closed.catch(() => {});
	});
	await chopin.next(message => message.type === "attach");
	chopin.send({ type: "start", session: "s1", mode: "planner" });
	await chopin.next(message => message.type === "started" && message.session === "s1");
	let count = 0;
	async function turn(fields: Record<string, unknown>, session = "s1") {
		let id = `t${++count}`;
		chopin.send({ type: "turn", session, turn: id, prompt: "", tools: TOOLS, ...fields });
		let end = await chopin.next(message => message.type === "turn-end" && message.turn === id);
		let parts = chopin.received
			.filter(message => message.type === "part" && message.turn === id)
			.map(message => message.part as StreamPart);
		let text = parts.flatMap(part => part.type === "text-delta" ? [part.delta] : []).join("");
		return { id, end, parts, text };
	}
	let agent = () =>
		readFileSync(log, "utf8").split("\n").filter(Boolean).map(line =>
			JSON.parse(line) as { new?: string; prompt?: string; said?: string; closed?: boolean }
		);
	return { chopin, dir, lines, stop, closed, turn, agent };
}

describe("acp-planner", () => {
	test(
		"runs each turn in one agent conversation, with Chopin's tools as its MCP server",
		async () => {
			let { chopin, dir, turn, agent } = await attached();
			let first = await turn({ prompt: "use the tools and edit", instructions: "Plan carefully." });
			expect(first.end).toMatchObject({ status: "finished" });
			expect(first.text).toBe(
				'listed read_plan,edit_plan; read_plan {"revision":3,"blocks":["Intro"]}; edit_plan '
					+ '{"ok":true,"input":{"revision":3,"operations":[{"op":"insert","index":0,"source":"Added by the ACP Planner.\\n"}]}}',
			);
			expect(first.parts[0]).toEqual({ type: "stream-start" });
			expect(first.parts.slice(-2).map(part => part.type)).toEqual(["finish-step", "finish"]);
			expect(
				chopin.received.filter(message => message.type === "host-tool-call").map(message =>
					message.toolName
				),
			)
				.toEqual(["read_plan", "edit_plan"]);

			let second = await turn({ prompt: "and now hello", instructions: "Plan carefully." });
			expect(second.text).toBe("echo: and now hello");
			expect(second.parts.map(part => part.type)).toContain("reasoning-delta");
			let third = await turn({ prompt: "changed", instructions: "Plan boldly." });
			expect(third.end).toMatchObject({ status: "finished" });

			let prompts = agent().flatMap(entry => entry.prompt ?? []);
			expect(prompts[0]).toContain("<chopin_instructions>");
			expect(prompts[0]).toContain("Plan carefully.");
			expect(prompts[1]).not.toContain("<chopin_instructions>");
			expect(prompts[2]).toContain("Plan boldly.");
			expect(agent().filter(entry => entry.new)).toEqual([{ new: dir }]);
		},
		60_000,
	);

	test("a JSON turn answers with the JSON alone", async () => {
		let { turn, agent } = await attached();
		let result = await turn({
			prompt: "json please",
			responseFormat: { type: "json", schema: { type: "object" } },
		});
		expect(result.end).toMatchObject({ status: "finished" });
		expect(result.text).toBe('{"title":"Release plan"}');
		expect(result.parts.filter(part => part.type === "text-start")).toHaveLength(1);
		expect(agent().flatMap(entry => entry.prompt ?? []).at(-1)).toContain(
			'Answer with one JSON value and nothing else, matching this JSON Schema:\n{"type":"object"}',
		);
	}, 60_000);

	test("a tool the turn does not offer fails in the agent and never reaches Chopin", async () => {
		let { chopin, turn } = await attached();
		let result = await turn({ prompt: "call a missing tool" });
		expect(result.text).toBe(
			"listed read_plan,edit_plan; error Chopin does not offer not_offered in this turn.",
		);
		expect(chopin.received.some(message => message.type === "host-tool-call")).toBe(false);
	}, 60_000);

	test("abort ends the turn at once, cancels the agent, and the next turn still runs", async () => {
		let { chopin, turn } = await attached();
		chopin.send({ type: "turn", session: "s1", turn: "held", prompt: "hold on", tools: TOOLS });
		await chopin.next(message =>
			message.type === "part" && (message.part as StreamPart).type === "text-delta"
		);
		let aborted = Date.now();
		chopin.send({ type: "abort", session: "s1", turn: "held" });
		expect(await chopin.next(message => message.type === "turn-end" && message.turn === "held"))
			.toMatchObject({ status: "aborted" });
		expect(Date.now() - aborted).toBeLessThan(5_000);
		expect((await turn({ prompt: "afterwards" })).text).toBe("echo: afterwards");
	}, 60_000);

	test(
		"permission: reads inside the checkout and Chopin's tools are allowed, the rest rejected",
		async () => {
			let { turn } = await attached();
			// execute, read inside, read outside, fetch, Chopin's tool, Chopin's name on an execute
			expect((await turn({ prompt: "permission check" })).text).toBe("no,yes,no,no,yes,no");
		},
		60_000,
	);

	test("--allow all allows every request, and --decline cancel answers cancelled", async () => {
		expect((await (await attached({ allow: "all" })).turn({ prompt: "permission check" })).text)
			.toBe("yes,yes,yes,yes,yes,yes");
		expect(
			(await (await attached({ decline: "cancel" })).turn({ prompt: "permission check" })).text,
		)
			.toBe("cancelled,yes,cancelled,cancelled,yes,cancelled");
	}, 60_000);

	test("an agent without HTTP MCP reaches Chopin's tools through the stdio proxy", async () => {
		let { chopin, turn } = await attached({ flags: ["--stdio"] });
		let result = await turn({ prompt: "use the tools" });
		expect(result.text).toBe(
			'listed read_plan,edit_plan; read_plan {"revision":3,"blocks":["Intro"]}',
		);
		expect(chopin.received.filter(message => message.type === "host-tool-call")).toHaveLength(1);
	}, 60_000);

	test(
		"an agent that exits is started again, with the instructions, on the next turn",
		async () => {
			let { turn, agent } = await attached();
			let crashed = await turn({ prompt: "crash now", instructions: "Plan carefully." });
			expect(crashed.end).toMatchObject({ status: "failed" });
			let next = await turn({ prompt: "back again", instructions: "Plan carefully." });
			expect(next.text).toBe("echo: back again");
			expect(agent().filter(entry => entry.new)).toHaveLength(2);
			expect(agent().flatMap(entry => entry.prompt ?? []).at(-1)).toContain("Plan carefully.");
		},
		60_000,
	);

	test(
		"a cancelled prompt's late tool call never runs, and the next turn waits for it",
		async () => {
			let { chopin, turn, agent } = await attached();
			chopin.send({ type: "turn", session: "s1", turn: "late", prompt: "late call", tools: TOOLS });
			await chopin.next(message =>
				message.type === "part" && message.turn === "late"
				&& (message.part as StreamPart).type === "text-delta"
			);
			chopin.send({ type: "abort", session: "s1", turn: "late" });
			await chopin.next(message => message.type === "turn-end" && message.turn === "late");
			expect((await turn({ prompt: "afterwards" })).text).toBe("echo: afterwards");
			expect(chopin.received.some(message => message.type === "host-tool-call")).toBe(false);
			expect(agent().flatMap(entry => entry.said ?? []).find(said => said.startsWith("late")))
				.toBe("late read_plan error No Chopin turn is running, so Chopin's tools are unavailable.");
		},
		60_000,
	);

	test("an abort while the agent starts sends no prompt, and the turn ends at once", async () => {
		let { chopin, turn, agent } = await attached({ flags: ["--slow-start"] });
		chopin.send({ type: "turn", session: "s1", turn: "early", prompt: "too soon", tools: TOOLS });
		await Bun.sleep(200);
		let at = Date.now();
		chopin.send({ type: "abort", session: "s1", turn: "early" });
		expect(await chopin.next(message => message.type === "turn-end" && message.turn === "early"))
			.toMatchObject({ status: "aborted" });
		expect(Date.now() - at).toBeLessThan(1_000);
		expect((await turn({ prompt: "then this" })).text).toBe("echo: then this");
		expect(agent().flatMap(entry => entry.prompt ?? [])).toEqual(["then this"]);
		expect(agent().filter(entry => entry.new)).toHaveLength(1);
	}, 60_000);

	test(
		"an agent that ignores a cancel is stopped, and the next turn starts a fresh one",
		async () => {
			let { chopin, turn, agent, lines } = await attached({ windDownMs: 1_000 });
			chopin.send({ type: "turn", session: "s1", turn: "stuck", prompt: "stubborn", tools: TOOLS });
			await chopin.next(message =>
				message.type === "part" && message.turn === "stuck"
				&& (message.part as StreamPart).type === "text-delta"
			);
			chopin.send({ type: "abort", session: "s1", turn: "stuck" });
			await chopin.next(message => message.type === "turn-end" && message.turn === "stuck");
			expect((await turn({ prompt: "fresh" })).text).toBe("echo: fresh");
			expect(agent().filter(entry => entry.new)).toHaveLength(2);
			expect(lines.some(line => line.includes("after a cancel, so it was stopped"))).toBe(true);
		},
		60_000,
	);

	test(
		"an isolated session works in an empty directory and may use only Chopin's tools",
		async () => {
			let { chopin, dir, turn, agent } = await attached({ allow: "all" });
			chopin.send({ type: "start", session: "bg", mode: "isolated" });
			await chopin.next(message => message.type === "started" && message.session === "bg");
			expect((await turn({ prompt: "permission check" }, "bg")).text).toBe("no,no,no,no,yes,no");
			let where = agent().flatMap(entry => entry.new ?? []);
			expect(where).toHaveLength(1);
			expect(where[0]).not.toBe(dir);
			expect(where[0]).toContain("chopin-acp-planner-");
		},
		60_000,
	);

	test("an agent that fails to start fails the turn without showing what it printed", async () => {
		let { turn, lines } = await attached({
			command: ["bun", "-e", "console.error('agent secret detail'); process.exit(4)"],
		});
		expect((await turn({ prompt: "hello" })).end).toMatchObject({
			status: "failed",
			message: "The ACP agent did not start; the acp-planner output says why.",
		});
		expect(lines.join("\n")).toContain("agent secret detail");
	}, 60_000);

	test("destroy closes the session's agent, and detaching stops the rest", async () => {
		let { chopin, turn, agent, stop, closed } = await attached();
		await turn({ prompt: "hello" });
		chopin.send({ type: "destroy", session: "s1" });
		for (let i = 0; i < 50 && !agent().some(entry => entry.closed); i++) await Bun.sleep(100);
		expect(agent().some(entry => entry.closed)).toBe(true);
		chopin.send({ type: "start", session: "s2", mode: "isolated" });
		await chopin.next(message => message.type === "started" && message.session === "s2");
		stop.abort();
		expect((await closed).code).toBe(1000);
	}, 60_000);
});

function closedWith(code: number) {
	return { closed: { code, reason: "" } };
}

describe("acp-planner pieces", () => {
	test("jsonReply reads the reply, a fenced block, or the outermost object or array", () => {
		expect(jsonReply(' {"a": 1} ')).toEqual({ a: 1 });
		expect(jsonReply('Sure:\n```json\n{"a": [1]}\n```')).toEqual({ a: [1] });
		expect(jsonReply('The answer is {"a": {"b": 2}} as asked.')).toEqual({ a: { b: 2 } });
		expect(jsonReply("Here: [1, 2]")).toEqual([1, 2]);
		expect(() => jsonReply("no json here")).toThrow("did not answer with the JSON");
	});

	test("promptText sends instructions only when they change", () => {
		let turn = {
			type: "turn" as const,
			session: "s",
			turn: "t",
			prompt: "Hi",
			tools: [],
			instructions: "Do X.",
		};
		expect(promptText(turn, undefined)).toContain(`"${MCP_SERVER}" MCP server's tools`);
		expect(promptText(turn, "Do X.")).toBe("Hi");
		expect(promptText({ ...turn, instructions: undefined }, "Do X.")).toBe("Hi");
		expect(promptText({ ...turn, responseFormat: { type: "json" } }, "Do X."))
			.toBe("Hi\n\nAnswer with one JSON value and nothing else.");
	});

	test("streamer alternates text and reasoning parts and keeps a JSON turn whole", () => {
		let parts: StreamPart[] = [];
		let stream = streamer(part => parts.push(part), false);
		let chunk = (sessionUpdate: "agent_message_chunk" | "agent_thought_chunk", text: string) =>
			stream.update({ sessionUpdate, content: { type: "text", text } });
		chunk("agent_thought_chunk", "hmm");
		chunk("agent_message_chunk", "a");
		chunk("agent_message_chunk", "");
		chunk("agent_message_chunk", "b");
		stream.finish(undefined);
		expect(parts.map(part => part.type)).toEqual([
			"reasoning-start",
			"reasoning-delta",
			"reasoning-end",
			"text-start",
			"text-delta",
			"text-delta",
			"text-end",
		]);
		parts = [];
		let json = streamer(part => parts.push(part), true);
		json.update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: '{"x":' } });
		json.update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "1}" } });
		expect(parts).toEqual([]);
		json.finish({ type: "json" });
		expect(parts.find(part => part.type === "text-delta")).toMatchObject({ delta: '{"x":1}' });
	});

	test("permission never takes a Chopin tool's name over a kind that says otherwise", () => {
		let tools = new Map([["edit_plan", { name: "edit_plan" }]]);
		let ask = (kind: "edit" | "execute" | "other" | undefined, title: string) =>
			permission(
				{
					sessionId: "s",
					toolCall: { toolCallId: "x", ...(kind ? { kind } : {}), title },
					options: [
						{ optionId: "ok", name: "Allow", kind: "allow_always" },
						{ optionId: "no", name: "Reject", kind: "reject_once" },
					],
				},
				{ allow: "read", decline: "reject", cwd: "/work", tools },
			).outcome;
		expect(ask("edit", "chopin/edit_plan")).toEqual({ outcome: "selected", optionId: "no" });
		expect(ask("execute", "edit_plan")).toEqual({ outcome: "selected", optionId: "no" });
		expect(ask(undefined, "mcp__chopin__edit_plan")).toEqual({
			outcome: "selected",
			optionId: "ok",
		});
		expect(ask("other", "chopin: read_plan")).toEqual({ outcome: "selected", optionId: "no" });
	});

	test("retryable: drops and unavailability always, unreachable and still-held only after attaching", () => {
		expect(
			[1001, 1006, 1011, 1000, 4401, 4403, 4404, 4409].map(code =>
				retryable(closedWith(code), true)
			),
		)
			.toEqual([true, true, true, false, false, false, false, false]);
		let refused = (code: "unavailable" | "planner-attached" | "sign-in-required") => ({
			error: new AgentRefused(code, ""),
		});
		expect(retryable(refused("unavailable"), false)).toBe(true);
		expect(retryable(refused("planner-attached"), false)).toBe(false);
		expect(retryable(refused("planner-attached"), true)).toBe(true);
		expect(retryable(refused("sign-in-required"), true)).toBe(false);
		expect(retryable({ error: new Error("closed before attaching") }, false)).toBe(false);
		expect(retryable({ error: new Error("closed before attaching") }, true)).toBe(true);
	});

	test("bareOrigin drops credentials and refuses what it cannot read", () => {
		expect(bareOrigin("https://x:ghp_secret@github.com/o/r.git")).toBe(
			"https://github.com/o/r.git",
		);
		expect(bareOrigin("git@github.com:o/r.git")).toBe("git@github.com:o/r.git");
		expect(bareOrigin("https://x:a/b@github.com/o/r.git")).toBeUndefined();
		expect(bareOrigin("token@weird")).toBeUndefined();
	});

	test("checkoutInfo leaves credentials out of the origin", async () => {
		let dir = mkdtempSync(join(tmpdir(), "acp-planner-git-"));
		cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
		execFileSync("git", ["init", "-q", "-b", "main", dir]);
		execFileSync("git", [
			"-C",
			dir,
			"-c",
			"user.name=t",
			"-c",
			"user.email=t@t",
			"commit",
			"-q",
			"--allow-empty",
			"-m",
			"start",
		]);
		execFileSync("git", [
			"-C",
			dir,
			"remote",
			"add",
			"origin",
			"https://x-access-token:ghp_secret@github.com/octo-org/score.git",
		]);
		expect(await checkoutInfo(dir)).toMatchObject({
			origin: "https://github.com/octo-org/score.git",
			branch: "main",
		});
	});
});
