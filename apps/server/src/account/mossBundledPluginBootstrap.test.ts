import { randomUUID } from "node:crypto";
import { lstat, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import { createRejectedFileAlias } from "../../../../scripts/fixtures/filesystem-links.ts";

import { bootstrapMossBundledPlugins } from "./mossBundledPluginBootstrap.ts";

const homes: string[] = [];
async function managedHome(): Promise<string> {
  const home = await mkdtemp(path.join(tmpdir(), "moss-bootstrap-test-"));
  homes.push(home);
  await writeFile(
    path.join(home, ".moss-managed-home"),
    `moss-managed-codex-home-v2:${randomUUID()}\n`,
  );
  return home;
}
function inputFor(home: string) {
  return { expectedHomePath: home, homePath: home, initializedHomePath: home, accountId: "moss" };
}
afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

describe("managed image plugin bootstrap", () => {
  it("installs once and preserves a user's later uninstall across restarts", async () => {
    const home = await managedHome();
    const install = vi.fn(async () => undefined);
    await bootstrapMossBundledPlugins({ ...inputFor(home), install });
    expect(install).toHaveBeenCalledWith({
      marketplacePath: path.join(
        home,
        "moss-bundled-marketplace-v1",
        ".agents",
        "plugins",
        "marketplace.json",
      ),
      pluginName: "moss-imagegen",
    });
    expect(install).toHaveBeenCalledWith({
      marketplacePath: path.join(
        home,
        "moss-bundled-marketplace-v1",
        ".agents",
        "plugins",
        "marketplace.json",
      ),
      pluginName: "moss-plugin-creator",
    });
    const afterUninstall = vi.fn(
      async (_input: { marketplacePath: string; pluginName: string }) => undefined,
    );
    await bootstrapMossBundledPlugins({ ...inputFor(home), install: afterUninstall });
    expect(afterUninstall).not.toHaveBeenCalled();
    // A newly introduced default can seed independently of an existing marker.
    await rm(path.join(home, ".moss-plugin-creator-bootstrap-v1"));
    await bootstrapMossBundledPlugins({ ...inputFor(home), install: afterUninstall });
    expect(afterUninstall).toHaveBeenCalledTimes(1);
    expect(afterUninstall.mock.calls[0]?.[0]).toMatchObject({ pluginName: "moss-plugin-creator" });
  });

  it("retries a failed installation and coalesces concurrent first sessions", async () => {
    const home = await managedHome();
    const fail = vi.fn(async () => {
      throw new Error("Native installation failed");
    });
    await expect(bootstrapMossBundledPlugins({ ...inputFor(home), install: fail })).rejects.toThrow(
      "Native installation failed",
    );
    await expect(readFile(path.join(home, ".moss-imagegen-bootstrap-v1"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    const install = vi.fn(async () => undefined);
    await Promise.all([
      bootstrapMossBundledPlugins({ ...inputFor(home), install }),
      bootstrapMossBundledPlugins({ ...inputFor(home), install }),
    ]);
    expect(install).toHaveBeenCalledTimes(2);
  });

  it("never bootstraps personal or shadow homes", async () => {
    const home = await managedHome();
    const install = vi.fn(async () => undefined);
    await bootstrapMossBundledPlugins({ ...inputFor(home), accountId: "personal", install });
    await bootstrapMossBundledPlugins({
      ...inputFor(home),
      expectedHomePath: `${home}-other`,
      install,
    });
    await bootstrapMossBundledPlugins({
      ...inputFor(home),
      shadowHomePath: `${home}-shadow`,
      install,
    });
    expect(install).not.toHaveBeenCalled();
  });

  it("refuses invalid ownership, runtime home mismatch, and linked markers", async () => {
    const home = await managedHome();
    const other = await managedHome();
    const install = vi.fn(async () => undefined);
    await expect(
      bootstrapMossBundledPlugins({ ...inputFor(home), initializedHomePath: other, install }),
    ).rejects.toThrow(/different Codex home/);
    const marker = path.join(home, ".moss-managed-home");
    await writeFile(marker, "not owned\n");
    await expect(bootstrapMossBundledPlugins({ ...inputFor(home), install })).rejects.toThrow(
      /verified managed/,
    );
    await rm(marker);
    // A Windows junction in a file slot must be refused before following it.
    createRejectedFileAlias(path.join(other, ".moss-managed-home"), marker);
    expect((await lstat(marker)).isSymbolicLink()).toBe(true);
    await expect(bootstrapMossBundledPlugins({ ...inputFor(home), install })).rejects.toThrow(
      /regular file/,
    );
    expect(install).not.toHaveBeenCalled();
  });
});
