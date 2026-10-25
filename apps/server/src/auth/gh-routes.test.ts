import { describe, expect, it } from "bun:test";

import { GH_CLI_APP_SETTINGS, GitHubTokenClient } from "../github/client";
import { Router } from "../http/router";
import { MemoryStorage } from "../storage/memory/adapter";
import { GhUnavailable } from "./gh";
import { registerAuthRoutes } from "./routes";

import type { AuthConfig } from "./config";

const ORIGIN = "http://127.0.0.1:8787";
const DAY_MS = 24 * 60 * 60 * 1_000;

const CONFIG: AuthConfig = {
	origin: ORIGIN,
	encryptionKey: new Uint8Array(32).fill(9),
	gh: { port: 8787, command: "gh" },
};

const ACCOUNTS = new Map([
	["gho_first", "octocat"],
	["gho_second", "octocat"],
	["gho_mallory", "mallory"],
]);

function cookies(response: Response): string[] {
	return (response.headers as Headers & { getSetCookie(): string[] }).getSetCookie();
}

function fixture(config: AuthConfig = CONFIG) {
	let storage = new MemoryStorage();
	let now = new Date("2026-10-01T12:00:00.000Z");
	let token = "gho_first";
	let unavailable: GhUnavailable | undefined;
	let reads = 0;
	let rejected = new Set<string>();
	let requests: Array<{ path: string; token: string }> = [];
	let rotations: Array<[string, number]> = [];
	let revoked: string[] = [];
	let github = new GitHubTokenClient({
		fetch: async (input, init) => {
			let url = new URL(String(input));
			let bearer = new Headers(init?.headers).get("authorization")!.slice("Bearer ".length);
			requests.push({ path: url.pathname, token: bearer });
			let login = ACCOUNTS.get(bearer);
			if (!login || rejected.has(bearer)) {
				return Response.json({ message: "Bad credentials" }, { status: 401 });
			}
			if (url.pathname === "/user") {
				return Response.json({
					node_id: `U_${login}`,
					login,
					avatar_url: `https://avatars.test/${login}`,
				});
			}
			let repository = {
				node_id: "R_score",
				owner: { login: "octo-org" },
				name: "score",
				full_name: "octo-org/score",
				private: true,
				html_url: "https://github.test/octo-org/score",
				default_branch: "main",
				permissions: { pull: true, push: true, admin: false },
			};
			if (url.pathname === "/user/repos") return Response.json([repository]);
			return Response.json(repository);
		},
		endpoints: { api: "https://api.test" },
		clock: () => now.getTime(),
	});
	let server = () => {
		let router = new Router();
		let auth = registerAuthRoutes(router, {
			config,
			storage,
			github,
			clock: () => now,
			ghToken: async () => {
				reads++;
				if (unavailable) throw unavailable;
				return token;
			},
			onCredentialsWillRotate: async (id, revision) => {
				rotations.push([id, revision]);
			},
			onSessionRevoked: async id => {
				revoked.push(id);
			},
		});
		return { router, auth };
	};
	let send = async (
		router: Router,
		path: string,
		{ method = "GET", cookie = "", headers = {} as Record<string, string> } = {},
	) =>
		(await router.handle(
			new Request(`${ORIGIN}${path}`, {
				method,
				headers: {
					...(method === "POST" ? { origin: ORIGIN } : {}),
					...(cookie ? { cookie } : {}),
					...headers,
				},
			}),
		))!;
	let signIn = async (router: Router, cookie = "") => {
		let response = await send(router, "/auth/gh", { method: "POST", cookie });
		let session = cookies(response).find(value => value.startsWith("chopin_session_8787="));
		return { response, cookie: session?.split(";", 1)[0] };
	};
	return {
		storage,
		requests,
		rotations,
		revoked,
		server,
		send,
		signIn,
		reads: () => reads,
		now: () => now,
		setToken: (value: string) => {
			token = value;
		},
		setUnavailable: (value: GhUnavailable | undefined) => {
			unavailable = value;
		},
		reject: (value: string) => rejected.add(value),
		advance: (ms: number) => {
			now = new Date(now.getTime() + ms);
		},
	};
}

function sessionId(cookie: string): string {
	return cookie.split("=", 2)[1]!.split(".")[0]!;
}

describe("GitHub CLI sign-in", () => {
	it("signs in with the gh token, reports the mode and lists what the token reaches", async () => {
		let f = fixture();
		let { router } = f.server();
		let signedOut = await f.send(router, "/api/session");
		expect(await signedOut.json()).toMatchObject({ user: null, auth: "gh" });

		let { response, cookie } = await f.signIn(router);
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ status: "complete" });
		expect(cookie).toBeDefined();
		expect(cookies(response).join("\n")).not.toContain("gho_first");

		let session = await f.send(router, "/api/session", { cookie });
		expect(await session.json()).toMatchObject({
			auth: "gh",
			installUrl: "/auth/github/install",
			user: { id: "U_octocat", login: "octocat" },
		});

		let installations = await f.send(router, "/api/github/installations", { cookie });
		expect(await installations.json()).toMatchObject({
			installations: [{ id: "0", account: { login: "octocat" }, repositorySelection: "all" }],
		});
		let repositories = await f.send(router, "/api/github/installations/0/repositories", {
			cookie,
		});
		expect(await repositories.json()).toMatchObject({
			repositories: [{ id: "R_score", fullName: "octo-org/score" }],
		});
		expect(f.reads()).toBe(1);
	});

	it("refuses a sign-in from another origin or host", async () => {
		let f = fixture();
		let { router } = f.server();
		let refused: Array<Record<string, string>> = [
			{ origin: "http://evil.test" },
			{ origin: "" },
			{ host: "evil.test:8787" },
			{ host: "localhost:8787" },
		];
		for (let headers of refused) {
			let response = await f.send(router, "/auth/gh", { method: "POST", headers });
			expect(response.status).toBe(403);
			expect(await response.json()).toEqual({ error: "origin is not allowed" });
		}
		expect(f.reads()).toBe(0);
	});

	it("reports a failed sign-in without a 401, the token, or a session", async () => {
		let unavailable = fixture();
		unavailable.setUnavailable(
			new GhUnavailable("GitHub CLI is not signed in; run `gh auth login`"),
		);
		let failed = await unavailable.signIn(unavailable.server().router);
		expect(failed.response.status).toBe(200);
		expect(await failed.response.json()).toEqual({
			status: "failed",
			message: "GitHub CLI is not signed in; run `gh auth login`",
		});
		expect(failed.cookie).toBeUndefined();

		let denied = fixture({ ...CONFIG, allowedUsers: new Set(["hubot"]) });
		let refused = await denied.signIn(denied.server().router);
		expect(refused.response.status).toBe(200);
		expect(await refused.response.json()).toEqual({
			status: "failed",
			message: "GitHub account is not allowed to use this Chopin instance",
		});
		expect(refused.cookie).toBeUndefined();
		expect(await denied.storage.users.get("U_octocat")).toBeUndefined();

		let revoked = fixture();
		revoked.reject("gho_first");
		let rejected = await revoked.signIn(revoked.server().router);
		expect(rejected.response.status).toBe(200);
		let body = await rejected.response.json();
		expect(body).toMatchObject({ status: "failed" });
		expect(JSON.stringify(body)).not.toContain("gho_first");
		expect(rejected.cookie).toBeUndefined();
	});

	it("registers no GitHub App or device-flow routes and sends access changes to the gh app", async () => {
		let f = fixture();
		let { router } = f.server();
		for (
			let [method, path] of [
				["GET", "/auth/github"],
				["GET", "/auth/github/callback?code=code&state=state"],
				["GET", "/auth/github/connector?key"],
				["POST", "/auth/device"],
				["GET", "/auth/device"],
				["POST", "/auth/device/complete"],
			]
		) {
			expect((await f.send(router, path, { method })).status).toBe(404);
		}
		let install = await f.send(router, "/auth/github/install");
		expect(install.status).toBe(302);
		expect(install.headers.get("location")).toBe(GH_CLI_APP_SETTINGS);
	});

	it("replaces this browser's earlier sign-in instead of adding another", async () => {
		let f = fixture();
		let { router } = f.server();
		let first = (await f.signIn(router)).cookie!;
		let second = (await f.signIn(router, first)).cookie!;
		expect(sessionId(second)).not.toBe(sessionId(first));
		expect(await f.storage.sessions.get(sessionId(first), f.now())).toBeUndefined();
		expect(f.revoked).toEqual([sessionId(first)]);
	});

	it("restores the encrypted login after a restart until it signs out", async () => {
		let f = fixture();
		let cookie = (await f.signIn(f.server().router)).cookie!;
		let restarted = f.server();
		let restored = await f.send(restarted.router, "/api/session", { cookie });
		expect(await restored.json()).toMatchObject({ user: { login: "octocat" } });
		expect(f.reads()).toBe(1);

		let logout = await f.send(restarted.router, "/auth/logout", { method: "POST", cookie });
		expect(logout.status).toBe(204);
		expect(await f.storage.sessions.get(sessionId(cookie), f.now())).toBeUndefined();
		let again = await f.send(f.server().router, "/api/session", { cookie });
		expect(await again.json()).toMatchObject({ user: null });
	});

	it("leaves a long-lived login alone until GitHub rejects its token", async () => {
		let f = fixture();
		let { router, auth } = f.server();
		let cookie = (await f.signIn(router)).cookie!;
		f.advance(29 * DAY_MS);
		let session = await f.send(router, "/api/session", { cookie });
		expect(await session.json()).toMatchObject({ user: { login: "octocat" } });
		expect(f.reads()).toBe(1);
		expect(f.rotations).toEqual([]);
		expect((await auth.sessions.forUser("U_octocat"))?.session.id).toBe(sessionId(cookie));
	});

	it("re-reads gh after a 401 and continues on a new token", async () => {
		let f = fixture();
		let { router } = f.server();
		let cookie = (await f.signIn(router)).cookie!;
		f.reject("gho_first");
		f.setToken("gho_second");
		f.advance(31_000);
		let installations = await f.send(router, "/api/github/installations", { cookie });
		expect(installations.status).toBe(200);
		expect(f.rotations).toEqual([[sessionId(cookie), 1]]);
		expect(f.reads()).toBe(2);
		expect(f.requests.at(-1)).toEqual({ path: "/user", token: "gho_second" });

		// The rotated token is what a restart restores.
		let restarted = f.server();
		let restored = await f.send(restarted.router, "/api/session", { cookie });
		expect(await restored.json()).toMatchObject({ user: { login: "octocat" } });
		expect(f.requests.at(-1)).toEqual({ path: "/user", token: "gho_second" });
		expect(f.reads()).toBe(2);
	});

	it("ends the login when gh still has the rejected token", async () => {
		let f = fixture();
		let { router } = f.server();
		let cookie = (await f.signIn(router)).cookie!;
		f.reject("gho_first");
		f.advance(31_000);
		let session = await f.send(router, "/api/session", { cookie });
		expect(await session.json()).toMatchObject({ user: null });
		expect(f.reads()).toBe(2);
		expect(f.revoked).toEqual([sessionId(cookie)]);
		expect(await f.storage.sessions.get(sessionId(cookie), f.now())).toBeUndefined();
	});

	it("ends the login when gh now names another account", async () => {
		let f = fixture();
		let { router } = f.server();
		let cookie = (await f.signIn(router)).cookie!;
		f.reject("gho_first");
		f.setToken("gho_mallory");
		f.advance(31_000);
		let session = await f.send(router, "/api/session", { cookie });
		expect(await session.json()).toMatchObject({ user: null });
		expect(f.revoked).toEqual([sessionId(cookie)]);
	});

	it("keeps the login, with a safe temporary error, while gh is unavailable", async () => {
		let f = fixture();
		let { router } = f.server();
		let cookie = (await f.signIn(router)).cookie!;
		f.reject("gho_first");
		f.setUnavailable(new GhUnavailable("GitHub CLI did not answer in time"));
		f.advance(31_000);
		let session = await f.send(router, "/api/session", { cookie });
		expect(session.status).toBe(503);
		expect(await session.json()).toEqual({ error: "GitHub CLI did not answer in time" });
		expect(f.revoked).toEqual([]);
		expect(await f.storage.sessions.get(sessionId(cookie), f.now())).toBeDefined();
	});
});
