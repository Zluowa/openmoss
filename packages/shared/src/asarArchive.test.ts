import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { extractAsarDirectory, packAsar } from "./asarArchive";

let work: string;
beforeEach(async () => {
  work = await mkdtemp(path.join(tmpdir(), "moss-asar-pack-"));
});
afterEach(async () => {
  await rm(work, { recursive: true, force: true });
});

describe("packAsar", () => {
  it("writes the same bytes every time, whatever order the reads finish in", async () => {
    const tree = path.join(work, "tree");
    // Many files of very different sizes, so parallel reads finish out of order.
    for (let index = 0; index < 120; index += 1) {
      const dir = path.join(tree, `d${index % 7}`, index % 3 === 0 ? "deep" : "");
      await mkdir(dir, { recursive: true });
      await writeFile(path.join(dir, `f${index}.js`), "x".repeat(((index * 7919) % 50_000) + 1));
    }
    const first = path.join(work, "first.asar");
    const second = path.join(work, "second.asar");
    await packAsar({ output: first, directories: { "apps/server/dist": tree } });
    await packAsar({ output: second, directories: { "apps/server/dist": tree } });
    expect((await readFile(first)).equals(await readFile(second))).toBe(true);

    const out = path.join(work, "out");
    expect(await extractAsarDirectory(first, "apps/server/dist", out)).toBe(120);
    expect(await readFile(path.join(out, "d3", "deep", "f3.js"), "utf8")).toBe(
      "x".repeat(((3 * 7919) % 50_000) + 1),
    );
  });
});
