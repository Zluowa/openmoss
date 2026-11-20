import path from "node:path";
import { DevsOutboundWorker, describeWorkerError } from "./devsOutboundWorker";
import { readDevsRepairConfig } from "./devsRepairConfig";
import { createRepairRunner, runRepairCommand } from "./devsRepairRunner";
import { validateLocalCodexConfig } from "./devsLocalExecutor";
import { githubTransport, trustedGitArgs, trustedGitEnvironment } from "./devsTrustedGit";
import { DevsMirror, devsWorkerReadiness, isFile } from "./devsWorkerReadiness";
import { DEVS_DEFAULT_DAILY_JOB_LIMIT, readDevsDailyLimit } from "@moss/shared/devsReport";

const { root, config, engines, required } = readDevsRepairConfig();
if (!config.localCodex || !config.githubVerifyRef)
  throw new Error(
    "The public developer worker requires local Codex and isolated GitHub verification.",
  );
const transport = githubTransport(config.repository, config.githubToken);
const magpie = validateLocalCodexConfig(config.localCodex);
const stamp = () => new Date().toISOString();
const log = (line: string) => console.error(`${stamp()} ${line}`);
// The mirror is fetched outside any job lease, with a long timeout, and kept warm in the
// background; a job clones from it and never fails just because GitHub is slow.
const mirror = new DevsMirror({
  stampFile: path.join(root, "mirror-fetched.json"),
  fetch: async (timeoutMs) => {
    await runRepairCommand(
      "git",
      [
        ...transport.args,
        "--git-dir",
        config.mirrorDir,
        "fetch",
        "--no-tags",
        transport.url,
        "+main:refs/heads/main",
      ],
      { cwd: root, env: transport.env, timeoutMs, secrets: [config.githubToken] },
    );
  },
  head: () =>
    runRepairCommand(
      "git",
      [
        ...trustedGitArgs(),
        "--git-dir",
        config.mirrorDir,
        "rev-parse",
        "--verify",
        "refs/heads/main",
      ],
      { cwd: root, env: trustedGitEnvironment(), timeoutMs: 30_000 },
    ),
  log,
});
await mirror.load();
mirror.start();
const localCodex = config.localCodex;
const worker = new DevsOutboundWorker({
  queueUrl: process.env.MOSS_DEVS_QUEUE_URL ?? "https://devs.mossbotai.com",
  token: required("MOSS_DEVS_WORKER_TOKEN"),
  stateDir: root,
  engines,
  dailyJobLimit: readDevsDailyLimit(
    process.env.MOSS_DEVS_DAILY_JOB_LIMIT,
    DEVS_DEFAULT_DAILY_JOB_LIMIT,
  ),
  // Every check runs before a claim, so a worker that cannot repair leaves reports queued.
  ready: devsWorkerReadiness(
    {
      "Magpie unreachable": async () => {
        const response = await fetch(new URL("api/hello", magpie), {
          redirect: "error",
          signal: AbortSignal.timeout(5_000),
        });
        if (!response.ok) return false;
        const hello = (await response.json()) as { name?: string };
        return hello.name === "magpie";
      },
      "Codex executable missing": () => isFile(localCodex.executable),
      "repository mirror out of date": () => mirror.isFresh(),
      ...(config.mirrorCi
        ? {
            "public mirror clone missing": () =>
              isFile(path.join(config.mirrorCi!.clone, ".git", "HEAD")),
          }
        : {}),
    },
    log,
  ),
  repair: async (report, authorizePublish) => {
    await mirror.topUp();
    return createRepairRunner({ ...config, beforePublish: authorizePublish })(report);
  },
});
let stopped = false;
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.once(signal, () => {
    stopped = true;
    mirror.stop();
  });
console.log(
  `${stamp()} Moss developer worker polling the production queue; Codex requests use local Magpie; repairs are verified on ${config.mirrorCi ? `the public mirror ${config.mirrorCi.repository}` : `${config.repository} CI`}.`,
);
// One line when the queue becomes unreachable (with the reason) and one when it is back,
// instead of a line every round; failed rounds back off to five minutes.
let failures = 0;
let lastReason = "";
while (!stopped) {
  let delay = 15_000;
  try {
    await worker.runOnce();
    if (failures)
      console.error(
        `${stamp()} Developer queue reachable again after ${failures} failed round(s) (last: ${lastReason}).`,
      );
    failures = 0;
    lastReason = "";
  } catch (error) {
    const reason = describeWorkerError(error);
    failures++;
    if (reason !== lastReason)
      console.error(
        `${stamp()} Developer queue unavailable (${reason}); the durable worker journal is retained. Retrying with backoff.`,
      );
    lastReason = reason;
    delay = Math.min(300_000, 15_000 * 2 ** Math.min(failures - 1, 5));
  }
  if (!stopped) await new Promise((resolve) => setTimeout(resolve, delay));
}
