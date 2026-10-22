/** What `ghToken` starts; `Bun.spawn` by default. */
export type GhSpawn = (argv: string[]) => {
	stdout: ReadableStream<Uint8Array>;
	exited: Promise<number>;
	kill(): void;
};

/** The GitHub CLI could not supply a token. The message is safe to show the operator. */
export class GhUnavailable extends Error {
	constructor(message: string) {
		super(message);
		this.name = "GhUnavailable";
	}
}

const TIMEOUT_MS = 10_000;
const TOKEN = /^[A-Za-z0-9_]+$/;

/**
 * Reads the operator's GitHub token with `gh auth token`, one read at a time. gh keeps its own
 * precedence (`GH_TOKEN`, `GH_CONFIG_DIR`) because the child inherits this process's environment.
 * Its output and errors are never surfaced: only fixed messages leave here.
 */
export function ghToken(
	options: { command: string; host: string; spawn?: GhSpawn; timeoutMs?: number },
): () => Promise<string> {
	let spawn = options.spawn
		?? (argv => Bun.spawn(argv, { stdin: "ignore", stdout: "pipe", stderr: "ignore" }));
	let pending: Promise<string> | undefined;
	let read = async () => {
		let child: ReturnType<GhSpawn>;
		try {
			child = spawn([options.command, "auth", "token", "--hostname", options.host]);
		} catch (err) {
			throw new GhUnavailable(
				(err as { code?: unknown } | undefined)?.code === "ENOENT"
					? "GitHub CLI (gh) was not found; install it or set CHOPIN_GH_PATH"
					: "GitHub CLI (gh) could not be started; check CHOPIN_GH_PATH",
			);
		}
		let timer: ReturnType<typeof setTimeout> | undefined;
		let expired = new Promise<never>((_resolve, reject) => {
			timer = setTimeout(() => {
				child.kill();
				reject(new GhUnavailable("GitHub CLI did not answer in time"));
			}, options.timeoutMs ?? TIMEOUT_MS);
		});
		let output: string;
		let code: number;
		try {
			[output, code] = await Promise.race([
				Promise.all([new Response(child.stdout).text(), child.exited]),
				expired,
			]);
		} catch (err) {
			if (err instanceof GhUnavailable) throw err;
			throw new GhUnavailable("GitHub CLI failed to report a token");
		} finally {
			clearTimeout(timer);
		}
		if (code !== 0) throw new GhUnavailable("GitHub CLI is not signed in; run `gh auth login`");
		let token = output.trim();
		if (!TOKEN.test(token)) throw new GhUnavailable("GitHub CLI returned an unreadable token");
		return token;
	};
	return () => {
		pending ??= read().finally(() => {
			pending = undefined;
		});
		return pending;
	};
}
