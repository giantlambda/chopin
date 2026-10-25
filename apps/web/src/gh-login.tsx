import { GitHubIcon } from "@chopin/icons";
import { useState } from "react";

import * as Api from "./api";
import { LocalLoginShell } from "./local-login-shell";
import { StatusBanner } from "./local-login-view";

type GhSignIn =
	| { status: "idle" | "signing-in" | "complete" }
	| { status: "failed"; message: string };

/** AUTH_MODE=gh: signs in as the account the server's GitHub CLI login holds. */
export function GhLogin() {
	let [state, setState] = useState<GhSignIn>({ status: "idle" });

	let signIn = async () => {
		setState({ status: "signing-in" });
		try {
			// A failure comes back in the body, never as a 401, which `Api.response` reloads on.
			let result = await Api.response<
				{ status: "complete" } | { status: "failed"; message: string }
			>("/auth/gh", { method: "POST" });
			if (result.status === "complete") {
				setState({ status: "complete" });
				location.reload();
				return;
			}
			setState({ status: "failed", message: result.message });
		} catch (reason) {
			setState({
				status: "failed",
				message: reason instanceof Error && reason.message ? reason.message : "Could not sign in.",
			});
		}
	};

	return (
		<LocalLoginShell>
			<p className="mt-2 text-sm text-text-secondary">
				Chopin uses the account the GitHub CLI is signed in to. Run{" "}
				<code className="font-mono text-text-primary">gh auth login</code> first.
			</p>
			{state.status === "failed" && (
				<StatusBanner role="alert" tone="danger">{state.message}</StatusBanner>
			)}
			{state.status === "complete"
				? <StatusBanner role="status" tone="success">Signing in...</StatusBanner>
				: (
					<button
						className="btn btn-md btn-primary mt-6 w-full"
						disabled={state.status === "signing-in"}
						onClick={() => void signIn()}
						type="button"
					>
						<GitHubIcon />
						Sign in with GitHub CLI
					</button>
				)}
		</LocalLoginShell>
	);
}
