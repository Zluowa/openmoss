import type { ServerProviderStatus } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import { formatMossTranslation, translateMoss } from "~/localization";

import {
  collectProviderUpdateTargets,
  getProviderUpdatePillView,
  PROVIDER_UPDATE_SUCCESS_VISIBLE_MS,
  resolveRailUpdatePresentation,
  type ProviderUpdateI18n,
} from "./providerUpdateRail.logic";

const EN: ProviderUpdateI18n = {
  locale: "en",
  t: (key) => translateMoss("en", key),
  format: (key, values) => formatMossTranslation("en", key, values),
};
const ZH: ProviderUpdateI18n = {
  locale: "zh-CN",
  t: (key) => translateMoss("zh-CN", key),
  format: (key, values) => formatMossTranslation("zh-CN", key, values),
};

const CHECKED_AT = "2026-10-31T00:00:00.000Z";

function provider(
  driver: string,
  overrides: Partial<ServerProviderStatus> & { readonly instanceId?: string } = {},
): ServerProviderStatus {
  return {
    provider: driver,
    driver,
    instanceId: driver,
    enabled: true,
    status: "ready",
    available: true,
    authStatus: "authenticated",
    checkedAt: CHECKED_AT,
    version: "1.0.0",
    versionAdvisory: {
      status: "behind_latest",
      currentVersion: "1.0.0",
      latestVersion: "1.1.0",
      updateCommand: `npm install -g ${driver}@latest`,
      canUpdate: true,
      checkedAt: CHECKED_AT,
      message: null,
    },
    ...overrides,
  } as unknown as ServerProviderStatus;
}

function updateState(
  status: "queued" | "running" | "succeeded" | "failed" | "unchanged",
  finishedAt: string | null = null,
  message: string | null = null,
) {
  return { updateState: { status, startedAt: null, finishedAt, message, output: null } };
}

describe("collectProviderUpdateTargets", () => {
  it("collapses instances that share a CLI onto the default instance", () => {
    const targets = collectProviderUpdateTargets([
      provider("pi", { instanceId: "pi_moss", displayName: "Pi (Moss)" } as never),
      provider("pi"),
    ]);
    expect(targets).toHaveLength(1);
    expect(targets[0]?.instanceId).toBe("pi");
    expect(targets[0]?.name).toBe("Pi");
  });

  it("keeps instances apart when they update through different commands", () => {
    const custom = provider("codex", { instanceId: "work" } as never);
    const targets = collectProviderUpdateTargets([
      provider("codex"),
      {
        ...custom,
        versionAdvisory: { ...custom.versionAdvisory!, updateCommand: "custom update" },
      },
    ]);
    expect(targets).toHaveLength(2);
  });

  it("reports the mirror and the last failure", () => {
    const base = provider("opencode", updateState("failed", CHECKED_AT, "exit 1"));
    const [target] = collectProviderUpdateTargets([
      { ...base, versionAdvisory: { ...base.versionAdvisory!, packageChannel: "cn-mirror" } },
    ]);
    expect(target?.usesCnMirror).toBe(true);
    expect(target?.failureMessage).toBe("exit 1");
  });

  it("skips drivers this build cannot update", () => {
    expect(collectProviderUpdateTargets([provider("retired-driver")])).toEqual([]);
  });
});

describe("getProviderUpdatePillView", () => {
  it("shows nothing when no update ran", () => {
    expect(getProviderUpdatePillView([provider("pi")], EN)).toBeNull();
  });

  it("names the agent while it updates", () => {
    const view = getProviderUpdatePillView([provider("opencode", updateState("running"))], EN);
    expect(view?.tone).toBe("loading");
    expect(view?.title).toBe("Updating OpenCode");
    expect(
      getProviderUpdatePillView([provider("opencode", updateState("queued"))], ZH)?.title,
    ).toBe("正在更新 OpenCode");
  });

  it("counts several agents updating at once", () => {
    const view = getProviderUpdatePillView(
      [provider("pi", updateState("running")), provider("codex", updateState("queued"))],
      EN,
    );
    expect(view?.title).toBe("Updating 2 agents");
    expect(view?.description).toBe("Pi and Codex updating.");
  });

  it("shows run progress, even before the server reports the first state", () => {
    const run = { total: 3, settled: 1, currentName: "Pi" };
    expect(getProviderUpdatePillView([provider("pi")], ZH, { run })?.title).toBe(
      "正在更新 Pi（2/3）",
    );
    const single = { total: 1, settled: 0, currentName: "Pi" };
    expect(getProviderUpdatePillView([provider("pi")], EN, { run: single })?.title).toBe(
      "Updating Pi",
    );
  });

  it("dismisses success on a timer and keeps failures until closed", () => {
    const success = getProviderUpdatePillView(
      [provider("pi", { version: "1.1.0", ...updateState("succeeded", CHECKED_AT) })],
      EN,
    );
    expect(success?.tone).toBe("success");
    expect(success?.title).toBe("Pi updated: v1.1.0");
    expect(success?.dismissAfterVisibleMs).toBe(PROVIDER_UPDATE_SUCCESS_VISIBLE_MS);

    const failure = getProviderUpdatePillView(
      [provider("pi", updateState("failed", CHECKED_AT, "Update command exited with code 1."))],
      EN,
    );
    expect(failure?.tone).toBe("error");
    expect(failure?.title).toBe("Pi v1.1.0 update failed");
    expect(failure?.description).toBe("Update command exited with code 1.");
    expect(failure?.dismissible).toBe(true);
    expect(failure?.dismissAfterVisibleMs).toBeUndefined();
  });

  it("warns when the command ran but the old version remains", () => {
    const view = getProviderUpdatePillView(
      [provider("pi", updateState("unchanged", CHECKED_AT))],
      EN,
    );
    expect(view?.tone).toBe("warning");
    expect(view?.title).toBe("Pi still needs an update");
  });

  it("hides results from before this window opened and those already dismissed", () => {
    const providers = [provider("pi", updateState("failed", "2026-10-30T00:00:00.000Z", "old"))];
    expect(getProviderUpdatePillView(providers, EN, { visibleAfterIso: CHECKED_AT })).toBeNull();

    const shown = getProviderUpdatePillView(providers, EN);
    expect(
      getProviderUpdatePillView(providers, EN, { dismissedKeys: new Set([shown!.key]) }),
    ).toBeNull();
  });

  it("shows the most recent result first", () => {
    const view = getProviderUpdatePillView(
      [
        provider("pi", updateState("failed", "2026-10-31T01:00:00.000Z", "boom")),
        provider("codex", updateState("succeeded", "2026-10-31T02:00:00.000Z")),
      ],
      EN,
    );
    expect(view?.tone).toBe("success");
  });
});

describe("resolveRailUpdatePresentation", () => {
  const noDesktop = { visible: false, status: null };

  it("rests when nothing needs the slot", () => {
    expect(
      resolveRailUpdatePresentation({ pillTone: null, targetCount: 0, desktop: noDesktop }),
    ).toBeNull();
    expect(
      resolveRailUpdatePresentation({ pillTone: "error", targetCount: 0, desktop: noDesktop }),
    ).toBeNull();
  });

  it("confirms agent updates before anything else can start", () => {
    expect(
      resolveRailUpdatePresentation({ pillTone: null, targetCount: 2, desktop: noDesktop }),
    ).toBe("update");
  });

  it("locks the button while agents update", () => {
    expect(
      resolveRailUpdatePresentation({ pillTone: "loading", targetCount: 2, desktop: noDesktop }),
    ).toBe("updating");
  });

  it("holds a ready app restart until the agents are done", () => {
    const desktop = { visible: true, status: "downloaded" } as const;
    expect(resolveRailUpdatePresentation({ pillTone: null, targetCount: 1, desktop })).toBe(
      "update",
    );
    expect(resolveRailUpdatePresentation({ pillTone: null, targetCount: 0, desktop })).toBe(
      "desktop",
    );
  });

  it("shows the app download's progress ahead of waiting agent updates", () => {
    expect(
      resolveRailUpdatePresentation({
        pillTone: null,
        targetCount: 1,
        desktop: { visible: true, status: "downloading" },
      }),
    ).toBe("desktop");
  });

  it("celebrates a finished update until its pill leaves", () => {
    expect(
      resolveRailUpdatePresentation({ pillTone: "success", targetCount: 0, desktop: noDesktop }),
    ).toBe("success");
  });
});
