import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { loadAuth } from "./config";

let saved = { ...process.env };

function base(extra: Record<string, string> = {}) {
	for (let key of ["AUTH_MODE", "DEMO_PERSONAS", "CHOPIN_GH_PATH"]) delete process.env[key];
	Object.assign(process.env, {
		GITHUB_APP_SLUG: "chopin-test",
		GITHUB_APP_CLIENT_ID: "client",
		GITHUB_APP_CLIENT_SECRET: "secret",
		APP_ORIGIN: "http://127.0.0.1:8787",
		SESSION_ENCRYPTION_KEY: "0".repeat(64),
		...extra,
	});
}

beforeEach(() => base());
afterEach(() => {
	process.env = { ...saved };
});

describe("DEMO_PERSONAS", () => {
	test("is off by default and when off", () => {
		expect(loadAuth(8787, "127.0.0.1").demoPersonas).toBeUndefined();
		base({ DEMO_PERSONAS: "off" });
		expect(loadAuth(8787, "127.0.0.1").demoPersonas).toBeUndefined();
	});

	test("on with local auth and loopback bind enables personas", () => {
		base({ AUTH_MODE: "local", DEMO_PERSONAS: "on" });
		expect(loadAuth(8787, "127.0.0.1").demoPersonas).toBe(true);
	});

	test("on without local auth refuses startup", () => {
		base({ DEMO_PERSONAS: "on" });
		expect(() => loadAuth(8787, "127.0.0.1")).toThrow("DEMO_PERSONAS=on requires AUTH_MODE=local");
	});

	test("on with a non-loopback bind refuses startup", () => {
		base({ AUTH_MODE: "local", DEMO_PERSONAS: "on" });
		expect(() => loadAuth(8787, "0.0.0.0")).toThrow("loopback");
	});

	test("other values refuse startup", () => {
		base({ AUTH_MODE: "local", DEMO_PERSONAS: "true" });
		expect(() => loadAuth(8787, "127.0.0.1")).toThrow("DEMO_PERSONAS must be on or off");
	});
});

describe("AUTH_MODE=gh", () => {
	function gh(extra: Record<string, string> = {}) {
		base({ AUTH_MODE: "gh", ...extra });
		for (let key of ["GITHUB_APP_SLUG", "GITHUB_APP_CLIENT_ID", "GITHUB_APP_CLIENT_SECRET"]) {
			delete process.env[key];
		}
	}

	test("loads on a loopback bind without any GitHub App variables", () => {
		gh();
		let config = loadAuth(8787, "127.0.0.1");
		expect(config.gh).toEqual({ port: 8787, command: "gh" });
		expect(config.local).toBeUndefined();
		expect(config.appSlug).toBeUndefined();
		expect(config.clientId).toBeUndefined();
		expect(config.clientSecret).toBeUndefined();
	});

	test("ignores leftover App variables and honours CHOPIN_GH_PATH", () => {
		base({ AUTH_MODE: "gh", CHOPIN_GH_PATH: "/opt/gh/bin/gh", GITHUB_APP_SLUG: "Not A Slug" });
		let config = loadAuth(8787, "127.0.0.1");
		expect(config.gh).toEqual({ port: 8787, command: "/opt/gh/bin/gh" });
		expect(config.appSlug).toBeUndefined();
		expect(config.clientSecret).toBeUndefined();
	});

	test("refuses a non-loopback bind, a non-loopback origin, or an origin on another port", () => {
		gh();
		expect(() => loadAuth(8787, "0.0.0.0")).toThrow("AUTH_MODE=gh requires a loopback");
		gh({ APP_ORIGIN: "https://chopin.example" });
		expect(() => loadAuth(8787, "127.0.0.1")).toThrow("AUTH_MODE=gh requires a loopback");
		gh({ APP_ORIGIN: "http://127.0.0.1:8790" });
		expect(() => loadAuth(8787, "127.0.0.1")).toThrow("AUTH_MODE=gh requires a loopback");
	});

	test("still requires the session encryption key", () => {
		gh({ SESSION_ENCRYPTION_KEY: "short" });
		expect(() => loadAuth(8787, "127.0.0.1")).toThrow("SESSION_ENCRYPTION_KEY");
	});

	test("accepts demo personas", () => {
		gh({ DEMO_PERSONAS: "on" });
		expect(loadAuth(8787, "127.0.0.1").demoPersonas).toBe(true);
	});

	test("names every mode when the value is unknown", () => {
		base({ AUTH_MODE: "cli" });
		expect(() => loadAuth(8787, "127.0.0.1")).toThrow("AUTH_MODE must be hosted, local, or gh");
	});
});
