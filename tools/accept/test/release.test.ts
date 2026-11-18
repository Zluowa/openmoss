import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { packerArgs, runCodeUpdatePipeline } from "../lib/codeUpdate.ts";
import { loadReleaseEnv, resolveReleaseFiles } from "../lib/releaseEnv.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});
function tempDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "accept-release-"));
  dirs.push(d);
  return d;
}

// Built from parts: no DSN- or URL-shaped literal sits in the source.
const fakeDsn = (n: number) =>
  ["https", "://", `k${n}`, "@", "ingest", ".example", ".invalid", `/${n}`].join("");
const fakeEndpoint = ["https", "://", "feedback", ".example", ".invalid", "/v1"].join("");

function plant(
  dir: string,
  sentry: Record<string, string>,
  feedback?: string,
): { sentry: string; feedback: string } {
  const sentryFile = path.join(dir, "sentry-build.env");
  fs.writeFileSync(
    sentryFile,
    `# comment\n${Object.entries(sentry)
      .map(([k, v]) => `${k}=${v}`)
      .join("\n")}\nOTHER=x\n`,
  );
  const feedbackFile = path.join(dir, "feedback.env");
  if (feedback !== undefined)
    fs.writeFileSync(feedbackFile, `MOSS_FEEDBACK_ENDPOINT="${feedback}"\n`);
  return { sentry: sentryFile, feedback: feedbackFile };
}

describe("release environment", () => {
  it("loads both DSNs and an https feedback endpoint, and names them", () => {
    const files = plant(
      tempDir(),
      { VITE_SENTRY_DSN: fakeDsn(1), MOSS_SENTRY_DSN: fakeDsn(2) },
      fakeEndpoint,
    );
    const release = loadReleaseEnv({
      sentryEnvFile: files.sentry,
      feedbackEnvFile: files.feedback,
    });
    expect(release.problems).toEqual([]);
    expect(release.loaded).toEqual([
      "MOSS_SENTRY_DSN",
      "VITE_FEEDBACK_ENDPOINT",
      "VITE_SENTRY_DSN",
    ]);
    expect(release.env.VITE_SENTRY_DSN).toBe(fakeDsn(1));
    expect(release.env.OTHER).toBeUndefined();
  });

  it("names every reason a release cannot be built", () => {
    const dir = tempDir();
    const files = plant(
      dir,
      { VITE_SENTRY_DSN: fakeDsn(1), MOSS_SENTRY_DSN: "" },
      "http://insecure.example.invalid",
    );
    expect(
      loadReleaseEnv({ sentryEnvFile: files.sentry, feedbackEnvFile: files.feedback }).problems,
    ).toEqual([
      "MOSS_SENTRY_DSN is missing or empty in the Sentry env file",
      "MOSS_FEEDBACK_ENDPOINT in the feedback env file must be an https address",
    ]);
    expect(
      loadReleaseEnv({ sentryEnvFile: undefined, feedbackEnvFile: undefined }).problems[0],
    ).toMatch(/no Sentry env file/);
    expect(
      loadReleaseEnv({ sentryEnvFile: path.join(dir, "absent.env"), feedbackEnvFile: undefined })
        .problems[0],
    ).toMatch(/does not exist/);
  });

  it("takes the file locations from flags first, then the ws profile's release section", () => {
    const dir = tempDir();
    const profile = path.join(dir, "profile.json");
    fs.writeFileSync(
      profile,
      JSON.stringify({ release: { sentryEnvFile: "/p/sentry.env", feedbackEnvFile: "/p/fb.env" } }),
    );
    expect(resolveReleaseFiles({}, profile)).toEqual({
      sentryEnvFile: "/p/sentry.env",
      feedbackEnvFile: "/p/fb.env",
    });
    expect(resolveReleaseFiles({ sentryEnv: "/f/s.env" }, profile).sentryEnvFile).toBe("/f/s.env");
    expect(resolveReleaseFiles({}, path.join(dir, "none.json"))).toEqual({
      sentryEnvFile: undefined,
      feedbackEnvFile: undefined,
    });
  });
});

describe("the pipeline's release and sign rules", () => {
  const base = () => {
    const out = tempDir();
    return {
      commit: "38e4428e1",
      shellApp: tempDir(),
      workTree: tempDir(), // not a git work tree: the checkout step refuses it, after the release rules
      dependencySource: tempDir(),
      outDir: out,
      cacheDir: tempDir(),
    };
  };

  it("refuses a release without both DSNs before anything runs", async () => {
    const lines: string[] = [];
    const result = await runCodeUpdatePipeline({
      ...base(),
      release: loadReleaseEnv({ sentryEnvFile: undefined, feedbackEnvFile: undefined }),
      log: (l) => lines.push(l),
    });
    expect(result.decision).toBe("refused");
    expect(result.reason).toMatch(/^release build refused: no Sentry env file/);
    expect(result.steps).toEqual([]);
  });

  it("says when a package carries no error reporting", async () => {
    const lines: string[] = [];
    await runCodeUpdatePipeline({ ...base(), log: (l) => lines.push(l) });
    expect(lines).toContain("not a release build: no error reporting in this package");
  });

  it("logs the names of a release's values, never the values, in the log or the run folder", async () => {
    const files = plant(
      tempDir(),
      { VITE_SENTRY_DSN: fakeDsn(7), MOSS_SENTRY_DSN: fakeDsn(8) },
      fakeEndpoint,
    );
    const lines: string[] = [];
    const o = {
      ...base(),
      release: loadReleaseEnv({ sentryEnvFile: files.sentry, feedbackEnvFile: files.feedback }),
    };
    await runCodeUpdatePipeline({ ...o, log: (l) => lines.push(l) });
    expect(lines).toContain(
      "release build: loaded MOSS_SENTRY_DSN, VITE_FEEDBACK_ENDPOINT, VITE_SENTRY_DSN",
    );
    const written = fs
      .readdirSync(o.outDir, { recursive: true, withFileTypes: true })
      .filter((e) => e.isFile())
      .map((e) => fs.readFileSync(path.join(e.parentPath, e.name), "utf8"))
      .join("\n");
    for (const secret of [fakeDsn(7), fakeDsn(8), fakeEndpoint]) {
      expect(lines.join("\n")).not.toContain(secret);
      expect(written).not.toContain(secret);
    }
  });

  it("passes --sign to the packer only when asked", () => {
    const o = { workTree: "/wt", shellApp: "/shell" };
    expect(packerArgs({ ...o, sign: true }, "/out", "/app")).toContain("--sign");
    expect(packerArgs(o, "/out", "/app")).not.toContain("--sign");
  });
});
