import { spawn } from "node:child_process";
import { once } from "node:events";
import { link, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, expect, it, vi } from "vitest";
import { upgradeManagedImageSkills } from "./mossBundledImageSkillUpgrade";
import { materializeMossBundledPluginMarketplace } from "./mossBundledPluginMarketplace";

const homes: string[] = [];
afterEach(async () => {
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
});

async function fixture(version: "1.0.4" | "preview" = "preview", name = "moss-imagegen") {
  const home = await mkdtemp(path.join(tmpdir(), "skill-upgrade-"));
  homes.push(home);
  await writeFile(path.join(home, ".moss-managed-home"), "moss-managed-codex-home-v1\n");
  const market = materializeMossBundledPluginMarketplace(home);
  const suffix = path.join("skills", name, "SKILL.md");
  const source = path.join(market.root, "plugins", name);
  const target = path.join(home, "plugins/cache/moss-bundled", name, "1.1.0", suffix);
  await mkdir(path.dirname(target), { recursive: true });
  const current = await readFile(path.join(source, suffix), "utf8");
  let old = current
    .replace(
      /^5\. .*$/m,
      "5. 记下返回的 jobId，大约每 15 秒用 `moss_media_get` 查询一次，直到完成。",
    )
    .replace("图片完成后由 Moss 显示在对话里。不要用", "完成后在对话里展示结果，不要用");
  if (version === "1.0.4") {
    old = old
      .replace(
        /^3\. .*$/m,
        "3. 调用 `moss_media_list`，确认所选模型 `available` 为 true。不可用时说明原因，并推荐表里另一个可用的模型，经对方同意后再换。",
      )
      .replace(
        /^6\. .*$/m,
        "6. 完成后图片会自动出现在对话里，并放到这段对话的 Moss 画布上，不要再用 Markdown 重复贴出。对方想在画布上查看或继续编辑时，调用 `moss_canvas_open` 并传入 jobId。",
      );
  }
  await writeFile(target, old);
  const detail = {
    marketplaceName: "moss-bundled",
    marketplacePath: market.manifestPath,
    summary: {
      name,
      id: name + "@moss-bundled",
      installed: true,
      enabled: true,
      localVersion: "1.1.0",
      availability: "AVAILABLE" as const,
      source: { type: "local" as const, path: source },
    },
  };
  const native = { name: name + ":" + name, path: target, enabled: true };
  const readPlugin = vi.fn(async () => detail);
  const listSkills = vi.fn(async () => [native]);
  const run = () =>
    upgradeManagedImageSkills({
      managedHomePath: home,
      runtimeHomePath: home,
      readPlugin,
      listSkills,
      assertCurrent() {},
    });
  return { target, current, old, detail, native, run, readPlugin, home };
}

it.each(["1.0.4", "preview"] as const)(
  "upgrades every shipped %s official image skill once by atomic replacement",
  async (version) => {
    for (const name of [
      "moss-imagegen",
      "moss-gpt-image",
      "moss-seedream",
      "moss-nano-banana",
      "moss-grok-image",
      "moss-wan-image",
    ]) {
      const f = await fixture(version, name);
      const before = await lstat(f.target, { bigint: true });
      expect((await Promise.all([f.run(), f.run()])).sort()).toEqual([false, true]);
      expect(await readFile(f.target, "utf8")).toBe(f.current);
      expect((await lstat(f.target, { bigint: true })).ino).not.toBe(before.ino);
      expect(f.readPlugin).toHaveBeenCalledTimes(1);
      expect(await readdir(path.dirname(f.target))).toEqual(["SKILL.md"]);
    }
  },
);

it.each([
  "disabled",
  "uninstalled",
  "skill disabled",
  "other marketplace",
  "other cache",
  "edited",
  "hard link",
  "removed",
] as const)("preserves an image cache when %s", async (caseName) => {
  const f = await fixture();
  if (caseName === "disabled") f.detail.summary.enabled = false;
  if (caseName === "uninstalled") f.detail.summary.installed = false;
  if (caseName === "skill disabled") f.native.enabled = false;
  if (caseName === "other marketplace") f.detail.marketplaceName = "elsewhere";
  if (caseName === "other cache") f.native.path = path.join(f.home, "another-skill");
  if (caseName === "edited") await writeFile(f.target, "my skill");
  if (caseName === "hard link") await link(f.target, path.join(f.home, "another-link"));
  if (caseName === "removed") await rm(f.target);
  expect(await f.run()).toBe(false);
  if (caseName === "removed")
    await expect(lstat(f.target)).rejects.toMatchObject({ code: "ENOENT" });
  else expect(await readFile(f.target, "utf8")).toBe(caseName === "edited" ? "my skill" : f.old);
});

it("preserves an edit made while native discovery is in progress", async () => {
  const f = await fixture();
  f.readPlugin.mockImplementation(async () => {
    await writeFile(f.target, "concurrent user edit");
    return f.detail;
  });
  expect(await f.run()).toBe(false);
  expect(await readFile(f.target, "utf8")).toBe("concurrent user edit");
  expect(await readdir(path.dirname(f.target))).toEqual(["SKILL.md"]);
});

it.runIf(process.platform === "win32")(
  "defers replacement while Windows holds the old skill, then retries on the next launch",
  async () => {
    const f = await fixture();
    const systemRoot = process.env.SystemRoot!;
    const child = spawn(
      path.join(systemRoot, "System32/WindowsPowerShell/v1.0/powershell.exe"),
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "$h=[IO.File]::Open($env:MOSS_TEST_SKILL,'Open','Read','Read');[Console]::WriteLine('held');[void][Console]::ReadLine();$h.Dispose()",
      ],
      { windowsHide: true, env: { SystemRoot: systemRoot, MOSS_TEST_SKILL: f.target } },
    );
    const closed = once(child, "close");
    try {
      const [ready] = await Promise.race([
        once(child.stdout, "data"),
        closed.then(() => {
          throw new Error("Skill lock failed");
        }),
      ]);
      expect(String(ready).trim()).toBe("held");
      expect(await f.run()).toBe(false);
      expect(await readFile(f.target, "utf8")).toBe(f.old);
      expect(await readdir(path.dirname(f.target))).toEqual(["SKILL.md"]);
    } finally {
      child.stdin.end("\n");
      await closed;
    }
    expect(await f.run()).toBe(true);
  },
);
