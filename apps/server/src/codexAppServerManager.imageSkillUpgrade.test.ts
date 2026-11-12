import { afterEach, describe, expect, it, vi } from "vitest";

const upgrade = vi.hoisted(() => ({
  calls: [] as Array<{ resolve: (v: boolean) => void; reject: (e: unknown) => void }>,
}));

vi.mock("./account/mossBundledImageSkillUpgrade.ts", () => ({
  upgradeManagedImageSkills: vi.fn(
    () =>
      new Promise<boolean>((resolve, reject) => {
        upgrade.calls.push({ resolve, reject });
      }),
  ),
}));
vi.mock("./account/mossBundledPluginBootstrap.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./account/mossBundledPluginBootstrap.ts")>()),
  bootstrapMossBundledPlugins: vi.fn(async () => undefined),
}));

import { CodexAppServerManager } from "./codexAppServerManager.ts";

type Internals = {
  bootstrapManagedPlugins: (context: unknown, initializeResponse: unknown) => Promise<void>;
  managedSourceHomeForOptions: (options: unknown) => string | undefined;
};

function harness() {
  const manager = new CodexAppServerManager();
  const internals = manager as unknown as Internals;
  vi.spyOn(internals, "managedSourceHomeForOptions").mockReturnValue("/moss/codex-home");
  const context = () => ({
    codexOptions: { accountId: "moss", homePath: "/moss/codex-home" },
    codexRuntimeHomePath: "/moss/codex-runtime",
    session: { cwd: "/work" },
  });
  const bootstrap = () =>
    internals.bootstrapManagedPlugins(context(), { codexHome: "/moss/codex-runtime" });
  return { bootstrap };
}

const settled = async (promise: Promise<unknown>) => {
  let done = false;
  void promise.then(() => {
    done = true;
  });
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
  return done;
};

afterEach(() => {
  upgrade.calls.length = 0;
});

describe("managed image skill upgrade", () => {
  it("does not hold up the session start", async () => {
    const { bootstrap } = harness();
    expect(await settled(bootstrap())).toBe(true);
    expect(upgrade.calls).toHaveLength(1);
  });

  it("runs once per managed home per process", async () => {
    const { bootstrap } = harness();
    await bootstrap();
    await bootstrap();
    expect(upgrade.calls).toHaveLength(1);
    upgrade.calls[0]!.resolve(false);
    await Promise.resolve();
    await bootstrap();
    expect(upgrade.calls).toHaveLength(1);
  });

  it("runs again in a later session after a failure", async () => {
    const { bootstrap } = harness();
    await bootstrap();
    upgrade.calls[0]!.reject(new Error("session stopped"));
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
    await bootstrap();
    expect(upgrade.calls).toHaveLength(2);
  });
});
