import { describe, expect, it, vi } from "vitest";
import { verifyRepairOnGitHub } from "./devsGithubVerification";

const trustedSha = "a".repeat(40);
const sourceSha = "b".repeat(40);
const reportId = "11111111-1111-1111-1111-111111111111";
function scenario(overrides: { conclusion?: string; headSha?: string } = {}) {
  const dispatches: unknown[] = [];
  const fetcher = vi.fn(async (url: unknown, options?: RequestInit) => {
    if (String(url).includes("/commits/")) return Response.json({ sha: trustedSha });
    if (String(url).endsWith("/dispatches")) {
      dispatches.push(JSON.parse(String(options?.body)));
      return new Response(null, { status: 204 });
    }
    return Response.json({
      workflow_runs: [
        {
          display_title: `Devs repair ${reportId} ${sourceSha}`,
          head_sha: overrides.headSha ?? trustedSha,
          event: "workflow_dispatch",
          status: "completed",
          conclusion: overrides.conclusion ?? "success",
        },
      ],
    });
  });
  return { dispatches, fetcher };
}
describe("trusted remote repair verification", () => {
  it("dispatches exact source bytes once and checks the trusted workflow revision", async () => {
    const { fetcher, dispatches } = scenario();
    await verifyRepairOnGitHub({
      repository: "fixture/repo",
      githubToken: "fixture-key",
      workflowRef: "main",
      reportId,
      sourceSha,
      timeoutMs: 1_000,
      fetcher,
    });
    expect(dispatches).toEqual([
      { ref: "main", inputs: { devs_report_id: reportId, devs_source_sha: sourceSha } },
    ]);
  });
  it.each([{ conclusion: "failure" }, { headSha: "c".repeat(40) }])(
    "fails closed on failed or mismatched checks %j",
    async (overrides) => {
      const { fetcher, dispatches } = scenario(overrides);
      await expect(
        verifyRepairOnGitHub({
          repository: "fixture/repo",
          githubToken: "fixture-key",
          workflowRef: "main",
          reportId,
          sourceSha,
          timeoutMs: 1_000,
          fetcher,
        }),
      ).rejects.toThrow();
      expect(dispatches).toHaveLength(1);
    },
  );
});
