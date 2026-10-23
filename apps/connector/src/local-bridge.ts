import { randomBytes, timingSafeEqual } from "node:crypto";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";

/**
 * Serve run-scoped MCP tools to a local ACP agent over loopback streamable HTTP. Some agents (Copilot
 * CLI in ACP mode) reject client-provided stdio servers, so connector-local tools need an HTTP URL.
 * Each request gets a fresh stateless server; a per-run bearer token keeps other local processes
 * and pages out.
 */
export function serveLocalBridge(open: () => Promise<Server>, options: { untimed?: boolean } = {}) {
	let token = randomBytes(32).toString("base64url");
	let expected = Buffer.from(`Bearer ${token}`);
	let http = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		idleTimeout: 255,
		async fetch(request, server) {
			let given = Buffer.from(request.headers.get("authorization") ?? "");
			if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
				return new Response(null, { status: 401 });
			}
			if (new URL(request.url).pathname !== "/mcp") return new Response(null, { status: 404 });
			// A call can wait on people, as `ask` waits on Decisions; the idle timeout would cut it.
			if (options.untimed) server.timeout(request, 0);
			let tools = await open();
			let transport = new WebStandardStreamableHTTPServerTransport({
				sessionIdGenerator: undefined,
				enableJsonResponse: true,
			});
			await tools.connect(transport);
			try {
				return await transport.handleRequest(request);
			} finally {
				void tools.close();
			}
		},
	});
	return {
		url: `http://127.0.0.1:${http.port}/mcp`,
		token,
		close: () => http.stop(true),
	};
}
