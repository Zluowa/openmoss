// FILE: gitProcessEnvironment.ts
// Purpose: The one place that decides how interactive a git process Moss starts may be.
// Layer: Git process policy (used by GitCore.execute and the few direct git/gh spawns)
//
// Moss runs git on its own all the time (status and upstream fetches for the Environment
// card, worktrees, branch publishing). On Windows a credential lookup in any of those reaches
// Git Credential Manager, which opens a GitHub account picker out of nowhere, and an askpass
// helper (VS Code's, git-gui's) can pop up too. GIT_TERMINAL_PROMPT=0 alone does not stop
// either. So every git command is non-interactive, and only a network action the person
// started (push, pull) may let Git Credential Manager show its sign-in window.

import { gitSubcommand } from "./Layers/GitCommandAdmission.ts";

/** Subcommands that can talk to a remote and therefore ask for credentials. */
const GIT_NETWORK_SUBCOMMANDS: ReadonlySet<string> = new Set([
  "clone",
  "fetch",
  "lfs",
  "ls-remote",
  "pull",
  "push",
  "remote",
  "submodule",
]);

export function isGitNetworkCommand(args: ReadonlyArray<string>): boolean {
  const subcommand = gitSubcommand(args);
  return subcommand !== undefined && GIT_NETWORK_SUBCOMMANDS.has(subcommand);
}

/** No prompt of any kind: no terminal, no askpass helper, no Credential Manager window. */
export const NON_INTERACTIVE_GIT_ENV = {
  GIT_TERMINAL_PROMPT: "0",
  GCM_INTERACTIVE: "never",
  GIT_ASKPASS: "",
  SSH_ASKPASS_REQUIRE: "never",
} as const satisfies NodeJS.ProcessEnv;

/**
 * Stall guard for HTTP(S) transfers: give up when fewer than 1 KB/s arrive for 60 s, so a dead
 * remote cannot hang a fetch or push forever while a large but moving transfer still finishes.
 */
export const GIT_STALLED_TRANSFER_ENV = {
  GIT_HTTP_LOW_SPEED_LIMIT: "1000",
  GIT_HTTP_LOW_SPEED_TIME: "60",
} as const satisfies NodeJS.ProcessEnv;

export interface GitCommandEnvironmentInput {
  readonly args: ReadonlyArray<string>;
  readonly env?: NodeJS.ProcessEnv | undefined;
  /**
   * Only for a network action the person started and is waiting for (push, pull). Git
   * Credential Manager may then show its sign-in window; there is still no terminal prompt.
   * Background and automatic work never sets this.
   */
  readonly allowCredentialPrompt?: boolean | undefined;
}

/** Environment overrides for one git command; the caller's own values win for the stall guard. */
export function gitCommandEnvironment(input: GitCommandEnvironmentInput): NodeJS.ProcessEnv {
  return {
    ...(isGitNetworkCommand(input.args) ? GIT_STALLED_TRANSFER_ENV : {}),
    ...input.env,
    GIT_TERMINAL_PROMPT: "0",
    ...(input.allowCredentialPrompt === true
      ? {}
      : {
          GCM_INTERACTIVE: NON_INTERACTIVE_GIT_ENV.GCM_INTERACTIVE,
          GIT_ASKPASS: NON_INTERACTIVE_GIT_ENV.GIT_ASKPASS,
          SSH_ASKPASS_REQUIRE: NON_INTERACTIVE_GIT_ENV.SSH_ASKPASS_REQUIRE,
        }),
  };
}

const GIT_AUTHENTICATION_FAILURE_PATTERN =
  /could not read (?:Username|Password) for|terminal prompts disabled|Authentication failed for|Cannot prompt because user interactivity has been disabled|Permission denied \(publickey|HTTP Basic: Access denied|Invalid username or password|returned error: 40[13]\b/i;

/** Plain-language replacement for git's sign-in failures, or null for any other error. */
export function describeGitAuthenticationFailure(stderr: string): string | null {
  return GIT_AUTHENTICATION_FAILURE_PATTERN.test(stderr)
    ? "The remote needs you to sign in before Moss can sync. Sign in to GitHub (or this remote) once with Git on this computer, then try again."
    : null;
}
