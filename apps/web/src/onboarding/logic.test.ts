import { describe, expect, it } from "vitest";

import {
  classifyProviderSetup,
  describeOnboardingAgentSummary,
  describeOnboardingDoneSummary,
  isOnboardingSetupStep,
  nextOnboardingStep,
  previousOnboardingStep,
  resolveLocalOnboardingCompletion,
  resolveOnboardingCompletionToReconcile,
  resolveOnboardingGate,
  summarizeProviderSetup,
  toggleSelection,
} from "./logic";

const COMPLETED_AT = "2026-09-07T00:00:00.000Z";
const NOW = "2026-09-08T00:00:00.000Z";

const GATE_BASE = {
  installationKeyStatus: "success",
  threadsHydrated: true,
  settingsSettled: true,
  projectCount: 0,
  serverCompletedAt: null,
  localCompletedAt: null,
} as const;

const RECONCILE_BASE = {
  threadsHydrated: true,
  settingsAvailable: true,
  projectCount: 0,
  serverCompletedAt: null,
  localCompletedAt: null,
  now: NOW,
} as const;

describe("onboarding steps", () => {
  it("clamps navigation at both ends", () => {
    expect(nextOnboardingStep("welcome")).toBe("tour");
    expect(nextOnboardingStep("done")).toBe("done");
    expect(previousOnboardingStep("tour")).toBe("welcome");
    expect(previousOnboardingStep("welcome")).toBe("welcome");
  });

  it("treats everything after the tour as a setup step", () => {
    expect(isOnboardingSetupStep("welcome")).toBe(false);
    expect(isOnboardingSetupStep("tour")).toBe(false);
    expect(isOnboardingSetupStep("providers")).toBe(true);
    expect(isOnboardingSetupStep("done")).toBe(true);
  });
});

describe("resolveOnboardingGate", () => {
  it("stays pending until projects and settings have loaded", () => {
    expect(resolveOnboardingGate({ ...GATE_BASE, threadsHydrated: false })).toBe("pending");
    expect(resolveOnboardingGate({ ...GATE_BASE, settingsSettled: false })).toBe("pending");
  });

  it("waits for the installation identity before offering first-run completion", () => {
    expect(resolveOnboardingGate({ ...GATE_BASE, installationKeyStatus: "pending" })).toBe(
      "pending",
    );
  });

  it("leaves the app usable after config failure and offers the tour after recovery", () => {
    expect(resolveOnboardingGate({ ...GATE_BASE, installationKeyStatus: "error" })).toBe("hidden");
    expect(resolveOnboardingGate(GATE_BASE)).toBe("show");
  });

  it("hides once any ordinary project exists", () => {
    expect(resolveOnboardingGate({ ...GATE_BASE, projectCount: 1 })).toBe("hidden");
  });

  it("hides when either completion marker is set", () => {
    expect(resolveOnboardingGate({ ...GATE_BASE, serverCompletedAt: COMPLETED_AT })).toBe("hidden");
    // A local marker covers a completion whose server write failed.
    expect(resolveOnboardingGate({ ...GATE_BASE, localCompletedAt: COMPLETED_AT })).toBe("hidden");
  });
});

describe("resolveLocalOnboardingCompletion", () => {
  it("only counts a marker recorded against the current installation", () => {
    const local = { completedAt: COMPLETED_AT, installationKey: "/home/a/.moss/worktrees" };
    expect(resolveLocalOnboardingCompletion(local, "/home/a/.moss/worktrees")).toBe(COMPLETED_AT);
    expect(resolveLocalOnboardingCompletion(local, "/home/b/.moss/worktrees")).toBeNull();
  });

  it("ignores a marker when either installation identity is unknown", () => {
    expect(
      resolveLocalOnboardingCompletion({ completedAt: COMPLETED_AT, installationKey: "/a" }, null),
    ).toBeNull();
    expect(
      resolveLocalOnboardingCompletion({ completedAt: COMPLETED_AT, installationKey: null }, "/a"),
    ).toBeNull();
  });
});

describe("resolveOnboardingCompletionToReconcile", () => {
  it("does not copy an unscoped completion onto a fresh installation", () => {
    const localCompletedAt = resolveLocalOnboardingCompletion(
      { completedAt: COMPLETED_AT, installationKey: null },
      "/new-installation/worktrees",
    );
    expect(
      resolveOnboardingCompletionToReconcile({ ...RECONCILE_BASE, localCompletedAt }),
    ).toBeNull();
    expect(resolveOnboardingGate({ ...GATE_BASE, localCompletedAt })).toBe("show");
  });

  it("does nothing before hydration, without readable settings, or once the server has a marker", () => {
    expect(
      resolveOnboardingCompletionToReconcile({
        ...RECONCILE_BASE,
        threadsHydrated: false,
        localCompletedAt: COMPLETED_AT,
      }),
    ).toBeNull();
    expect(
      resolveOnboardingCompletionToReconcile({
        ...RECONCILE_BASE,
        settingsAvailable: false,
        localCompletedAt: COMPLETED_AT,
      }),
    ).toBeNull();
    expect(
      resolveOnboardingCompletionToReconcile({
        ...RECONCILE_BASE,
        serverCompletedAt: COMPLETED_AT,
        localCompletedAt: COMPLETED_AT,
        projectCount: 3,
      }),
    ).toBeNull();
  });

  it("replays a local completion whose server write failed", () => {
    expect(
      resolveOnboardingCompletionToReconcile({ ...RECONCILE_BASE, localCompletedAt: COMPLETED_AT }),
    ).toBe(COMPLETED_AT);
  });

  it("exempts an installation that predates the tour", () => {
    expect(resolveOnboardingCompletionToReconcile({ ...RECONCILE_BASE, projectCount: 1 })).toBe(
      NOW,
    );
  });
});

describe("classifyProviderSetup", () => {
  it("reads a signed-out agent as connected while its Moss lane runs it", () => {
    expect(
      classifyProviderSetup({
        readiness: { state: "needsLogin" },
        disabled: false,
        servedByMoss: true,
      }),
    ).toBe("connected");
    expect(classifyProviderSetup({ readiness: { state: "needsLogin" }, disabled: false })).toBe(
      "needs-sign-in",
    );
  });

  it("treats a disabled provider as disabled regardless of detection", () => {
    expect(classifyProviderSetup({ readiness: { state: "ready" }, disabled: true })).toBe(
      "disabled",
    );
  });

  it("offers the install for agents the server reports missing", () => {
    expect(classifyProviderSetup({ readiness: null, disabled: false })).toBe("not-installed");
    expect(classifyProviderSetup({ readiness: { state: "notInstalled" }, disabled: false })).toBe(
      "not-installed",
    );
  });

  it("waits for an in-flight probe before calling a provider without status not installed", () => {
    expect(classifyProviderSetup({ readiness: null, disabled: false, detecting: true })).toBe(
      "detecting",
    );
    expect(classifyProviderSetup({ readiness: { state: "checking" }, disabled: false })).toBe(
      "detecting",
    );
    expect(
      classifyProviderSetup({
        readiness: { state: "notInstalled" },
        disabled: false,
        detecting: true,
      }),
    ).toBe("not-installed");
    expect(classifyProviderSetup({ readiness: null, disabled: true, detecting: true })).toBe(
      "disabled",
    );
  });

  it("keeps a missing provider unknown if detection fails", () => {
    expect(classifyProviderSetup({ readiness: null, disabled: false, detectionFailed: true })).toBe(
      "check-failed",
    );
    expect(
      classifyProviderSetup({
        readiness: { state: "notInstalled" },
        disabled: false,
        detectionFailed: true,
      }),
    ).toBe("not-installed");
  });

  it("follows the server's readiness for found agents", () => {
    expect(classifyProviderSetup({ readiness: { state: "needsLogin" }, disabled: false })).toBe(
      "needs-sign-in",
    );
    expect(classifyProviderSetup({ readiness: { state: "ready" }, disabled: false })).toBe(
      "connected",
    );
    expect(classifyProviderSetup({ readiness: { state: "error" }, disabled: false })).toBe(
      "unavailable",
    );
  });
});

describe("summarizeProviderSetup", () => {
  it("counts each state and excludes disabled providers from enabled", () => {
    expect(
      summarizeProviderSetup([
        { provider: "codex", state: "connected" },
        { provider: "claudeAgent", state: "needs-sign-in" },
        { provider: "cursor", state: "not-installed" },
        { provider: "opencode", state: "detecting" },
        { provider: "grok", state: "check-failed" },
        { provider: "pi", state: "disabled" },
      ]),
    ).toEqual({
      enabled: 5,
      connected: 1,
      needsSignIn: 1,
      notInstalled: 1,
      detecting: 1,
      checkFailed: 1,
    });
  });

  it("keeps the final welcome summary truthful until detection succeeds", () => {
    const summaryFor = (state: "detecting" | "check-failed" | "connected") =>
      describeOnboardingAgentSummary(summarizeProviderSetup([{ provider: "codex", state }]));

    expect(summaryFor("detecting")).toBe("Checking agents…");
    expect(summaryFor("check-failed")).toBe("Could not check all agents");
    expect(summaryFor("connected")).toBe("1 agent connected");
  });
});

describe("toggleSelection", () => {
  it("adds and removes without mutating the input", () => {
    const initial: ReadonlySet<string> = new Set(["a"]);
    const added = toggleSelection(initial, "b");
    expect([...added]).toEqual(["a", "b"]);
    expect([...initial]).toEqual(["a"]);
    expect([...toggleSelection(added, "a")]).toEqual(["b"]);
  });
});

describe("onboarding finish summary", () => {
  it("reads in Chinese for a zh-CN reader", () => {
    const summary = summarizeProviderSetup([
      { provider: "codex", state: "connected" },
      { provider: "grok", state: "connected" },
    ]);
    expect(
      describeOnboardingDoneSummary({
        agents: describeOnboardingAgentSummary(summary, "zh-CN"),
        themeLabel: "Moss",
        projectsAdded: 0,
        locale: "zh-CN",
      }),
    ).toBe("已连接 2 个智能体 · Moss 主题 · 还没有项目");
  });

  it("keeps the English wording for other locales", () => {
    expect(
      describeOnboardingDoneSummary({
        agents: "6 agents connected",
        themeLabel: "Moss",
        projectsAdded: 2,
      }),
    ).toBe("6 agents connected · Moss theme · 2 projects added");
  });

  it("names no count for projects Moss already had, so it can't disagree with the sidebar", () => {
    expect(
      describeOnboardingDoneSummary({
        agents: "已连接 6 个智能体",
        themeLabel: "Moss",
        projectsAdded: 0,
        existingProjects: 3,
        locale: "zh-CN",
      }),
    ).toBe("已连接 6 个智能体 · Moss 主题");
    expect(
      describeOnboardingDoneSummary({
        agents: "6 agents connected",
        themeLabel: "Moss",
        projectsAdded: 0,
        existingProjects: 1,
      }),
    ).toBe("6 agents connected · Moss theme");
  });
});
