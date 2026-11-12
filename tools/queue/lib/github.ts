// FILE: tools/queue/lib/github.ts
// Purpose: The GitHub calls the queue makes, through `gh api` so the token stays inside gh.
// Layer: tool library
// Exports: GitHub, GitHubError, PullInfo, MergeResponse

import type { Runner } from "./runner.ts";

export class GitHubError extends Error {
  constructor(
    message: string,
    readonly status: number | undefined,
  ) {
    super(message);
  }
}

export interface PullInfo {
  readonly number: number;
  readonly title: string;
  readonly state: "open" | "closed";
  readonly merged: boolean;
  readonly head: string;
  readonly headRef: string;
  readonly baseRef: string;
  readonly mergeCommit: string | undefined;
  readonly draft: boolean;
}

export interface MergeResponse {
  readonly sha: string;
  readonly merged: boolean;
  readonly message: string;
}

export class GitHub {
  constructor(
    private readonly runner: Runner,
    private readonly gh: string,
    readonly repo: string,
  ) {}

  private async api(args: readonly string[]): Promise<unknown> {
    const r = await this.runner.run(this.gh, ["api", ...args], { timeoutMs: 120_000 });
    if (r.code !== 0) {
      const status = /\(HTTP (\d{3})\)/.exec(r.stderr)?.[1];
      let message = r.stderr.trim().split("\n")[0] ?? "";
      try {
        const body = JSON.parse(r.stdout) as { message?: string };
        if (body.message) message = body.message;
      } catch {
        // not JSON
      }
      throw new GitHubError(
        `gh api ${args.filter((a) => !a.startsWith("-")).join(" ")}: ${message}`,
        status ? Number(status) : undefined,
      );
    }
    try {
      return JSON.parse(r.stdout) as unknown;
    } catch {
      throw new GitHubError(`gh api ${args.join(" ")}: response is not JSON`, undefined);
    }
  }

  async getPull(n: number): Promise<PullInfo> {
    const p = (await this.api([`repos/${this.repo}/pulls/${n}`])) as {
      number: number;
      title: string;
      state: "open" | "closed";
      merged: boolean;
      draft?: boolean;
      merge_commit_sha?: string | null;
      head: { sha: string; ref: string };
      base: { ref: string };
    };
    return {
      number: p.number,
      title: p.title,
      state: p.state,
      merged: p.merged,
      head: p.head.sha,
      headRef: p.head.ref,
      baseRef: p.base.ref,
      mergeCommit: p.merged ? (p.merge_commit_sha ?? undefined) : undefined,
      draft: p.draft ?? false,
    };
  }

  async retarget(n: number, base: string): Promise<void> {
    await this.api(["-X", "PATCH", `repos/${this.repo}/pulls/${n}`, "-f", `base=${base}`]);
  }

  /** Merges with a merge commit, pinned to `sha`: GitHub refuses when the head moved. */
  async merge(n: number, sha: string): Promise<MergeResponse> {
    const r = (await this.api([
      "-X",
      "PUT",
      `repos/${this.repo}/pulls/${n}/merge`,
      "-f",
      "merge_method=merge",
      "-f",
      `sha=${sha}`,
    ])) as { sha: string; merged: boolean; message: string };
    return { sha: r.sha, merged: r.merged, message: r.message };
  }
}
