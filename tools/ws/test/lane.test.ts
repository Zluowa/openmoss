import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, tempDir } from "./helpers.ts";

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "cli.ts");
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) cleanup(d);
});

function profileAt(base: string, floorGB: number): string {
  const file = path.join(base, "profile.json");
  fs.writeFileSync(
    file,
    JSON.stringify({
      primaryCheckout: path.join(base, "primary"),
      worktreeRoot: path.join(base, "wt"),
      stateDir: path.join(base, "state"),
      disk: { floorGB, drives: [base] },
      lock: { staleHours: 3, pollSeconds: 0.1 },
    }),
  );
  return file;
}

function runCli(
  profile: string,
  argv: string[],
): Promise<{ code: number; stderr: string; stdout: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...argv], {
      env: { ...process.env, MOSS_WS_PROFILE: profile, MOSS_WS_OWNER: "lane-test" },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("exit", (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

/** A child command that records its start and end times, sleeping in between. */
function sleeper(log: string, tag: string, ms: number): string[] {
  const js =
    `const fs=require('fs');fs.appendFileSync(${JSON.stringify(log)},'${tag} start '+Date.now()+'\\n');` +
    `setTimeout(()=>{fs.appendFileSync(${JSON.stringify(log)},'${tag} end '+Date.now()+'\\n')},${ms})`;
  return [process.execPath, "-e", js];
}

describe("ws lane", () => {
  it("serializes two concurrent runs and passes the exit code through", async () => {
    const base = tempDir("lane");
    dirs.push(base);
    const profile = profileAt(base, 0);
    const log = path.join(base, "times.log");
    const [a, b] = await Promise.all([
      runCli(profile, ["lane", "first", "--", ...sleeper(log, "a", 1500)]),
      runCli(profile, ["lane", "second", "--", ...sleeper(log, "b", 1500)]),
    ]);
    expect(a.code).toBe(0);
    expect(b.code).toBe(0);
    const times = Object.fromEntries(
      fs
        .readFileSync(log, "utf8")
        .trim()
        .split("\n")
        .map((l) => {
          const [tag, what, t] = l.split(" ");
          return [`${tag}.${what}`, Number(t)];
        }),
    );
    const [firstEnd, secondStart] =
      times["a.start"]! < times["b.start"]!
        ? [times["a.end"]!, times["b.start"]!]
        : [times["b.end"]!, times["a.start"]!];
    expect(secondStart).toBeGreaterThanOrEqual(firstEnd);
    expect(`${a.stderr}${b.stderr}`).toMatch(/waiting, position 1 in queue; held by lane-test/);
    expect(fs.existsSync(path.join(base, "state", "locks", "heavy"))).toBe(false);

    const failing = await runCli(profile, [
      "lane",
      "fails",
      "--",
      process.execPath,
      "-e",
      "process.exit(7)",
    ]);
    expect(failing.code).toBe(7);
    expect(fs.existsSync(path.join(base, "state", "locks", "heavy"))).toBe(false);
  });

  it("tells the command it runs which lane it is in", async () => {
    const base = tempDir("lane");
    dirs.push(base);
    const marker = path.join(base, "lane.txt");
    const r = await runCli(profileAt(base, 0), [
      "lane",
      "batch",
      "--",
      process.execPath,
      "-e",
      `require('fs').writeFileSync(${JSON.stringify(marker)},process.env.MOSS_WS_LANE||'')`,
    ]);
    expect(r.code).toBe(0);
    expect(fs.readFileSync(marker, "utf8")).toBe("batch");
  });

  it("refuses with a clear message when free space is under the floor", async () => {
    const base = tempDir("lane");
    dirs.push(base);
    const profile = profileAt(base, 1_000_000);
    const marker = path.join(base, "ran.txt");
    const r = await runCli(profile, [
      "lane",
      "big",
      "--",
      process.execPath,
      "-e",
      `require('fs').writeFileSync(${JSON.stringify(marker)},'x')`,
    ]);
    expect(r.code).toBe(9);
    expect(r.stderr).toMatch(
      /ws lane big refused before queueing\. Disk floor is 1000000 GB; below it: .* GB free/,
    );
    expect(fs.existsSync(marker)).toBe(false);
  });

  it("prints usage without a command", async () => {
    const base = tempDir("lane");
    dirs.push(base);
    const r = await runCli(profileAt(base, 0), ["lane", "x"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/usage: ws lane/);
  });
});
