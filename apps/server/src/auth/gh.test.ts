import { afterEach, describe, expect, it, spyOn } from "bun:test";

import { ghToken, GhUnavailable } from "./gh";

import type { GhSpawn } from "./gh";

const SECRET = "gho_cli_secret_value";

function child(stdout: string, code: number | undefined) {
	let killed = false;
	let finish: (code: number) => void = () => {};
	let exited = new Promise<number>(resolve => {
		finish = resolve;
		if (code !== undefined) resolve(code);
	});
	return {
		stdout: new Response(stdout).body!,
		exited,
		kill() {
			killed = true;
			finish(143);
		},
		get killed() {
			return killed;
		},
	};
}

function fake(make: () => ReturnType<typeof child>) {
	let calls: string[][] = [];
	let spawn: GhSpawn = argv => {
		calls.push(argv);
		return make();
	};
	return { calls, spawn };
}

async function failure(read: () => Promise<string>): Promise<GhUnavailable> {
	try {
		await read();
	} catch (err) {
		expect(err).toBeInstanceOf(GhUnavailable);
		return err as GhUnavailable;
	}
	throw new Error("expected the read to fail");
}

let spies: Array<{ mockRestore(): void }> = [];
afterEach(() => {
	for (let spy of spies) spy.mockRestore();
	spies = [];
});

describe("the GitHub CLI token source", () => {
	it("asks gh for github.com's token and trims its output", async () => {
		let { calls, spawn } = fake(() => child(`${SECRET}\n`, 0));
		let read = ghToken({ command: "/opt/gh", host: "github.com", spawn });
		expect(await read()).toBe(SECRET);
		expect(calls).toEqual([["/opt/gh", "auth", "token", "--hostname", "github.com"]]);
	});

	it("reports a missing or unstartable binary", async () => {
		let missing = ghToken({
			command: "gh",
			host: "github.com",
			spawn: () => {
				throw Object.assign(new Error(`Executable not found: ${SECRET}`), { code: "ENOENT" });
			},
		});
		expect((await failure(missing)).message)
			.toBe("GitHub CLI (gh) was not found; install it or set CHOPIN_GH_PATH");
		let denied = ghToken({
			command: "gh",
			host: "github.com",
			spawn: () => {
				throw Object.assign(new Error("EACCES"), { code: "EACCES" });
			},
		});
		expect((await failure(denied)).message).toContain("could not be started");
	});

	it("reports a signed-out gh without repeating what it printed", async () => {
		let { spawn } = fake(() => child(`partial ${SECRET}`, 1));
		let error = await failure(ghToken({ command: "gh", host: "github.com", spawn }));
		expect(error.message).toBe("GitHub CLI is not signed in; run `gh auth login`");
		expect(error.message).not.toContain(SECRET);
	});

	it("kills a gh that does not answer in time", async () => {
		let started: ReturnType<typeof child> | undefined;
		let { spawn } = fake(() => {
			started = child("", undefined);
			return started;
		});
		let error = await failure(ghToken({ command: "gh", host: "github.com", spawn, timeoutMs: 10 }));
		expect(error.message).toBe("GitHub CLI did not answer in time");
		expect(started!.killed).toBe(true);
	});

	it("refuses output that is not a token", async () => {
		for (let output of ["", "\n", `${SECRET} extra`, `${SECRET}\nsecond line`, "gho_ünïcode"]) {
			let { spawn } = fake(() => child(output, 0));
			let error = await failure(ghToken({ command: "gh", host: "github.com", spawn }));
			expect(error.message).toBe("GitHub CLI returned an unreadable token");
			expect(error.message).not.toContain(SECRET);
		}
	});

	it("shares one gh run between concurrent reads, then runs again", async () => {
		let { calls, spawn } = fake(() => child(SECRET, 0));
		let read = ghToken({ command: "gh", host: "github.com", spawn });
		expect(await Promise.all([read(), read(), read()])).toEqual([SECRET, SECRET, SECRET]);
		expect(calls).toHaveLength(1);
		expect(await read()).toBe(SECRET);
		expect(calls).toHaveLength(2);
	});

	it("never logs the token or gh's output", async () => {
		let logged: unknown[] = [];
		for (let method of ["log", "error", "warn", "info", "debug"] as const) {
			spies.push(spyOn(console, method).mockImplementation((...args) => logged.push(...args)));
		}
		for (let [output, code] of [[SECRET, 0], [`oops ${SECRET}`, 1], [`${SECRET} x`, 0]] as const) {
			let { spawn } = fake(() => child(output, code));
			await ghToken({ command: "gh", host: "github.com", spawn })().catch(() => {});
		}
		expect(logged).toEqual([]);
	});
});
