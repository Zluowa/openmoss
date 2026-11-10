import type { DevsFetch } from "./devsReports";

/** Runs model-edited checks on an ephemeral GitHub runner, never on the maintainer's host. */
export async function verifyRepairOnGitHub(options: {
  repository: string;
  githubToken: string;
  workflowRef: string;
  reportId: string;
  sourceSha: string;
  timeoutMs: number;
  fetcher?: DevsFetch;
  delay?: () => Promise<void>;
}) {
  const fetcher = options.fetcher ?? fetch;
  const api = `https://api.github.com/repos/${options.repository}`;
  const request = async (route: string, body?: unknown) => {
    const response = await fetcher(`${api}/${route}`, {
      method: body === undefined ? "GET" : "POST",
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
      headers: {
        authorization: `Bearer ${options.githubToken}`,
        accept: "application/vnd.github+json",
        "content-type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(
        `GitHub repair verification request failed (${response.status}); inspect the pushed job branch before retrying.`,
      );
    }
    return response.status === 204 ? null : await response.json();
  };
  const trusted = (await request(`commits/${encodeURIComponent(options.workflowRef)}`)) as {
    sha: string;
  };
  if (!/^[0-9a-f]{40}$/i.test(trusted.sha)) throw new Error("Invalid trusted workflow revision.");
  const name = `Devs repair ${options.reportId} ${options.sourceSha}`;
  const since = new Date(Date.now() - 60_000).toISOString();
  const workflow = "actions/workflows/backend.yml";
  // Dispatch is a one-shot external action: a lost response must never cause another repair.
  await request(`${workflow}/dispatches`, {
    ref: options.workflowRef,
    inputs: { devs_report_id: options.reportId, devs_source_sha: options.sourceSha },
  });
  const deadline = Date.now() + options.timeoutMs;
  while (Date.now() < deadline) {
    const result = (await request(
      `${workflow}/runs?event=workflow_dispatch&per_page=100&created=${encodeURIComponent(`>=${since}`)}`,
    )) as {
      workflow_runs: Array<{
        display_title: string;
        head_sha: string;
        event: string;
        status: string;
        conclusion: string | null;
      }>;
    };
    const runs = result.workflow_runs.filter((run) => run.display_title === name);
    if (runs.length > 1) throw new Error("Ambiguous repair verification receipt.");
    const run = runs[0];
    if (run) {
      if (run.head_sha !== trusted.sha || run.event !== "workflow_dispatch")
        throw new Error("Repair verification workflow revision changed.");
      if (run.status === "completed") {
        if (run.conclusion !== "success")
          throw new Error("The repair failed its trusted GitHub checks; no PR was created.");
        return;
      }
    }
    await (options.delay?.() ?? new Promise((resolve) => setTimeout(resolve, 15_000)));
  }
  throw new Error("GitHub repair checks timed out; inspect the pushed job branch before retrying.");
}
