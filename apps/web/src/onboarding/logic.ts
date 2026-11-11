// FILE: logic.ts
// Purpose: Pure step, gate, and provider-classification rules for the first-run welcome tour.
// Layer: Web domain helper (no React, no I/O)
// Exports: ONBOARDING_STEPS, nextOnboardingStep, previousOnboardingStep, resolveOnboardingGate,
//          resolveOnboardingCompletionToReconcile, resolveLocalOnboardingCompletion,
//          classifyProviderSetup, summarizeProviderSetup, toggleSelection

import type { ProviderKind, ServerProviderReadiness } from "@moss/contracts";

export const ONBOARDING_STEPS = [
  "welcome",
  "tour",
  "providers",
  "theme",
  "project",
  "done",
] as const;
export type OnboardingStep = (typeof ONBOARDING_STEPS)[number];

export function nextOnboardingStep(step: OnboardingStep): OnboardingStep {
  const index = ONBOARDING_STEPS.indexOf(step);
  return ONBOARDING_STEPS[Math.min(index + 1, ONBOARDING_STEPS.length - 1)] ?? "done";
}

export function previousOnboardingStep(step: OnboardingStep): OnboardingStep {
  const index = ONBOARDING_STEPS.indexOf(step);
  return ONBOARDING_STEPS[Math.max(index - 1, 0)] ?? "welcome";
}

/** Steps where the user has started making setup choices; the tour must not auto-close past here. */
export function isOnboardingSetupStep(step: OnboardingStep): boolean {
  return step !== "welcome" && step !== "tour";
}

export interface LocalOnboardingCompletion {
  readonly completedAt: string | null;
  /**
   * Identity of the server installation the completion was recorded against (its
   * worktrees directory). A browser origin can be pointed at a different server state or
   * home directory later; a marker from another installation must not hide its tour.
   */
  readonly installationKey: string | null;
}

/**
 * The local marker is a pending write for one installation, not unconditional completion.
 * It only counts when both identities are known and match the current server.
 */
export function resolveLocalOnboardingCompletion(
  local: LocalOnboardingCompletion,
  currentInstallationKey: string | null,
): string | null {
  if (local.completedAt === null) return null;
  if (currentInstallationKey === null || local.installationKey === null) {
    return null;
  }
  return local.installationKey === currentInstallationKey ? local.completedAt : null;
}

export type OnboardingGate = "pending" | "show" | "hidden";

export interface OnboardingGateInputs {
  /** Wait for an installation identity; config failures defer the tour without blocking the app. */
  readonly installationKeyStatus: "pending" | "success" | "error";
  /** Local project state has been hydrated from the server at least once. */
  readonly threadsHydrated: boolean;
  /** The server settings query has settled (success or error). */
  readonly settingsSettled: boolean;
  /** Count of ordinary (non-container) projects. */
  readonly projectCount: number;
  readonly serverCompletedAt: string | null;
  /** Already scoped to this installation via `resolveLocalOnboardingCompletion`. */
  readonly localCompletedAt: string | null;
}

/**
 * The tour shows on a fresh install (no ordinary projects) that has not recorded
 * completion anywhere. Either marker counts: the server one is durable across browser
 * profiles, the local one covers a completion whose server write failed and is
 * reconciled back to the server on the next launch (see
 * `resolveOnboardingCompletionToReconcile`).
 *
 * The result is *not* authoritative until the inputs are: callers re-evaluate as
 * snapshots and settings arrive instead of latching the first non-pending answer.
 */
export function resolveOnboardingGate(input: OnboardingGateInputs): OnboardingGate {
  if (
    input.installationKeyStatus === "pending" ||
    !input.threadsHydrated ||
    !input.settingsSettled
  ) {
    return "pending";
  }
  if (input.installationKeyStatus === "error") return "hidden";
  const completed = input.serverCompletedAt !== null || input.localCompletedAt !== null;
  return !completed && input.projectCount === 0 ? "show" : "hidden";
}

export interface OnboardingReconcileInputs {
  readonly threadsHydrated: boolean;
  /** Server settings are readable, so a null marker is a real absence, not a fetch error. */
  readonly settingsAvailable: boolean;
  readonly projectCount: number;
  readonly serverCompletedAt: string | null;
  readonly localCompletedAt: string | null;
  /** ISO timestamp used when an existing install is exempted without a local marker. */
  readonly now: string;
}

/**
 * Returns the completion timestamp to write to the server, or null when nothing is owed.
 * Two cases need the marker persisted after the fact:
 * - a completion whose server write failed (only the local marker exists), and
 * - an installation that predates the tour (projects exist, no marker anywhere), which
 *   must never see the "first run" tour just because its last project is later removed.
 */
export function resolveOnboardingCompletionToReconcile(
  input: OnboardingReconcileInputs,
): string | null {
  if (!input.threadsHydrated || !input.settingsAvailable || input.serverCompletedAt !== null) {
    return null;
  }
  if (input.localCompletedAt !== null) {
    return input.localCompletedAt;
  }
  return input.projectCount > 0 ? input.now : null;
}

export type ProviderSetupState =
  | "connected"
  | "needs-sign-in"
  | "not-installed"
  | "unavailable"
  | "detecting"
  | "check-failed"
  | "disabled";

/**
 * One card's state from the server's readiness for the agent (see `resolveAgentReadiness`):
 * found and signed in reads connected, found but signed out asks for a sign-in, missing
 * offers the install, and anything still being probed waits.
 */
export function classifyProviderSetup(input: {
  readonly readiness: Pick<ServerProviderReadiness, "state"> | null | undefined;
  readonly disabled: boolean;
  /** A working Moss lane runs this agent, so its own signed-out login needs nothing. */
  readonly servedByMoss?: boolean;
  readonly detecting?: boolean;
  readonly detectionFailed?: boolean;
}): ProviderSetupState {
  if (input.disabled) return "disabled";
  const state = input.readiness?.state;
  if (!state || state === "checking") {
    if (input.detecting) return "detecting";
    if (input.detectionFailed) return "check-failed";
    return state === "checking" ? "detecting" : "not-installed";
  }
  switch (state) {
    case "ready":
      return "connected";
    case "needsLogin":
      return input.servedByMoss === true ? "connected" : "needs-sign-in";
    case "notInstalled":
      return "not-installed";
    case "error":
      return "unavailable";
  }
}

export interface ProviderSetupSummary {
  readonly enabled: number;
  readonly connected: number;
  readonly needsSignIn: number;
  readonly notInstalled: number;
  readonly detecting: number;
  readonly checkFailed: number;
}

export function summarizeProviderSetup(
  states: ReadonlyArray<{ readonly provider: ProviderKind; readonly state: ProviderSetupState }>,
): ProviderSetupSummary {
  let enabled = 0;
  let connected = 0;
  let needsSignIn = 0;
  let notInstalled = 0;
  let detecting = 0;
  let checkFailed = 0;
  for (const entry of states) {
    if (entry.state !== "disabled") enabled += 1;
    if (entry.state === "connected") connected += 1;
    if (entry.state === "needs-sign-in") needsSignIn += 1;
    if (entry.state === "not-installed") notInstalled += 1;
    if (entry.state === "detecting") detecting += 1;
    if (entry.state === "check-failed") checkFailed += 1;
  }
  return { enabled, connected, needsSignIn, notInstalled, detecting, checkFailed };
}

export function describeOnboardingAgentSummary(
  summary: ProviderSetupSummary,
  locale = "en",
): string {
  const zh = locale.toLowerCase().startsWith("zh");
  if (summary.detecting > 0) return zh ? "正在检查智能体…" : "Checking agents…";
  if (summary.checkFailed > 0) return zh ? "有些智能体没能检查" : "Could not check all agents";
  if (zh) return `已连接 ${summary.connected} 个智能体`;
  return `${summary.connected} agent${summary.connected === 1 ? "" : "s"} connected`;
}

// The last step's one-line summary: agents, theme, projects. It names a project count only
// for projects added in this tour: the stored list also holds projects the sidebar doesn't
// show (Home, Groups, hidden imports), so any other count could disagree with the sidebar.
export function describeOnboardingDoneSummary(input: {
  readonly agents: string;
  readonly themeLabel: string;
  readonly projectsAdded: number;
  /** Projects Moss already had before this tour (a replayed tour, an earlier import). */
  readonly existingProjects?: number;
  readonly locale?: string;
}): string {
  const zh = (input.locale ?? "en").toLowerCase().startsWith("zh");
  const existing = input.existingProjects ?? 0;
  const projects =
    input.projectsAdded > 0
      ? zh
        ? `已添加 ${input.projectsAdded} 个项目`
        : `${input.projectsAdded} project${input.projectsAdded === 1 ? "" : "s"} added`
      : existing > 0
        ? null
        : zh
          ? "还没有项目"
          : "No project yet";
  const theme = zh ? `${input.themeLabel} 主题` : `${input.themeLabel} theme`;
  return [input.agents, theme, projects].filter((part) => part !== null).join(" · ");
}

export function toggleSelection<T>(selection: ReadonlySet<T>, id: T): ReadonlySet<T> {
  const next = new Set(selection);
  if (next.has(id)) {
    next.delete(id);
  } else {
    next.add(id);
  }
  return next;
}
