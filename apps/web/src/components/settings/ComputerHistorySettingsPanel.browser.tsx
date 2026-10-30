// FILE: ComputerHistorySettingsPanel.browser.tsx
// Purpose: Exercise the real Computer History settings panel through the browser harness.
// Scope: state gates, consent, permissions, timeline actions, handoffs, and keyboard paths.

import "../../index.css";

import axe from "axe-core";
import { page, userEvent } from "vitest/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { buildThemeCssVariables, DEFAULT_THEME_STATE, resolveThemePack } from "~/theme/theme.logic";

function applyCodexDarkElectronTheme(): () => void {
  const root = document.documentElement;
  const previousRuntime = root.dataset.runtime;
  const wasDark = root.classList.contains("dark");
  const { variables } = buildThemeCssVariables(
    resolveThemePack(DEFAULT_THEME_STATE, "dark"),
    "dark",
    { electron: true, isMac: true, systemUiFont: true },
  );
  const previousVariables = new Map(
    Object.keys(variables).map((name) => [name, root.style.getPropertyValue(name)]),
  );

  root.classList.add("dark");
  root.dataset.runtime = "electron";
  for (const [name, value] of Object.entries(variables)) {
    if (value) root.style.setProperty(name, value);
    else root.style.removeProperty(name);
  }

  return () => {
    for (const [name, value] of previousVariables) {
      if (value) root.style.setProperty(name, value);
      else root.style.removeProperty(name);
    }
    if (!wasDark) root.classList.remove("dark");
    if (previousRuntime) root.dataset.runtime = previousRuntime;
    else delete root.dataset.runtime;
  };
}

const harness = vi.hoisted(() => ({
  api: {
    shell: {
      openExternal: vi.fn(),
    },
    computerHistory: {
      getState: vi.fn(),
      getSettings: vi.fn(),
      updateSettings: vi.fn(),
      listApplications: vi.fn(),
      resolveApplications: vi.fn(),
      setEnabled: vi.fn(),
      retryActivation: vi.fn(),
      pause: vi.fn(),
      resume: vi.fn(),
      listHistory: vi.fn(),
      listHistorySuggestions: vi.fn(),
      listHistorySummaryIntervals: vi.fn(),
      revealInFinder: vi.fn(),
      clearHistory: vi.fn(),
    },
  },
  handleNewChat: vi.fn(),
  setPrompt: vi.fn(),
  setMentions: vi.fn(),
  toastAdd: vi.fn(),
}));

vi.mock("~/nativeApi", () => ({
  ensureNativeApi: () => harness.api,
  readNativeApi: () => harness.api,
}));

vi.mock("~/hooks/useHandleNewChat", () => ({
  useHandleNewChat: () => ({ handleNewChat: harness.handleNewChat }),
}));

vi.mock("~/composerDraftStore", () => ({
  useComposerDraftStore: {
    getState: () => ({ setPrompt: harness.setPrompt, setMentions: harness.setMentions }),
  },
}));

vi.mock("~/components/ui/toast", () => ({
  toastManager: { add: harness.toastAdd },
}));

vi.mock("~/localization", () => {
  const copy: Record<string, string> = {
    "settings.history.title": "Computer History",
    "settings.history.description": "A local history.",
    "settings.history.enableDescription":
      "Augment memories with your computer activity so Moss can help with anything you’re working on.",
    "settings.history.learnMore": "Learn more",
    "settings.history.learnMorePrivacy": "Learn more about privacy",
    "settings.history.turnOffAriaLabel": "Turn off Computer History",
    "settings.history.choose": "Choose",
    "settings.history.selectedCount": "{count} selected",
    "settings.history.historyTitle": "History",
    "settings.history.historyAbout": "About computer history",
    "settings.history.historyDescription": "Local history details.",
    "settings.history.askAboutHistory": "Ask about your history",
    "settings.history.loadingSettings": "Loading your settings…",
    "settings.history.loadingHistory": "Loading history…",
    "settings.history.loading": "Loading…",
    "settings.history.unavailable": "Computer History is unavailable on this platform.",
    "settings.history.state.off": "Off",
    "settings.history.state.on": "On",
    "settings.history.state.paused": "Paused",
    "settings.history.state.permission": "Permission needed",
    "settings.history.state.attention": "Needs attention",
    "settings.history.state.unknown": "Unknown",
    "settings.history.state.unavailableLabel": "Unavailable",
    "settings.history.off.title": "Let Moss follow your work",
    "settings.history.off.description": "Moss can summarize your activity.",
    "settings.history.off.benefits": "Ask about what you were working on.",
    "settings.history.off.privacy":
      "When turned on, Moss saves text summaries of your activity across allowed apps and websites, potentially including communications. Audio and private-mode web browsing are never included, and you can pause or clear your history and manage what’s included at any time. This feature increases token usage.",
    "settings.history.off.example.followUp.user": "What did I promise to send Sarah?",
    "settings.history.off.example.followUp.assistant": "You promised to send the budget by Friday.",
    "settings.history.off.example.beforeLunch.user": "What was I working on before lunch?",
    "settings.history.off.example.beforeLunch.assistant":
      "You were revising the launch presentation.",
    "settings.history.off.example.planningDocument.user": "Where is the planning document?",
    "settings.history.off.example.planningDocument.assistant":
      "You were reviewing the launch plan.",
    "settings.history.off.example.remodel.user": "Where was I on the remodel?",
    "settings.history.off.example.remodel.assistant": "You narrowed the backsplash to two options.",
    "settings.history.off.example.previous": "Previous example",
    "settings.history.off.example.next": "Next example",
    "settings.history.off.example.position": "Example {current} of {total}",
    "settings.history.turnOnAction": "Turn on",
    "settings.history.permissions": "Permissions",
    "settings.history.permissionsDescription":
      "Choose which apps and websites to exclude or include in computer history",
    "settings.history.finishSetup": "Finish setup",
    "settings.history.resume": "Resume",
    "settings.history.pause": "Pause",
    "settings.history.tryAgain": "Try again",
    "settings.history.continue": "Continue",
    "settings.history.noHistory": "No local history yet.",
    "settings.history.noSelectedApps": "No apps selected",
    "settings.history.noSelectedWebsites": "No websites selected",
    "settings.history.suggestions": "Suggested skills and automations",
    "settings.history.createSuggestedSkill": "Create {name} skill",
    "settings.history.createSuggestedAutomation": "Create {name} automation",
    "settings.history.suggestedSkill": "Suggested skill",
    "settings.history.suggestedAutomation": "Suggested automation",
    "settings.history.ask": "Ask about history",
    "settings.history.clearHistory": "Clear history",
    "settings.history.clearDialog": "Clear history",
    "settings.history.clearQuestion": "Clear {scope}?",
    "settings.history.clearQuestion.last10m": "Clear the last 10 minutes?",
    "settings.history.clearQuestion.last1h": "Clear the last hour?",
    "settings.history.clearQuestion.last1d": "Clear the last day?",
    "settings.history.clearQuestion.all": "Clear all history?",
    "settings.history.clearDescription":
      "Your actions and any memories created from them will be deleted. This cannot be undone.",
    "settings.history.clear": "Clear",
    "settings.history.scope.last10m": "Clear last 10 minutes",
    "settings.history.scope.last1h": "Clear last hour",
    "settings.history.scope.last1d": "Clear last day",
    "settings.history.scope.all": "Clear all",
    "settings.history.today": "Today",
    "settings.history.yesterday": "Yesterday",
    "settings.history.morning": "Morning",
    "settings.history.afternoon": "Afternoon",
    "settings.history.evening": "Evening",
    "settings.history.overnight": "Overnight",
    "settings.history.clearSuccess":
      "History cleared — Moss memory may take up to 6 hours to update",
    "settings.history.finderSuccess": "Revealed.",
    "settings.history.finderUnavailable": "Finder unavailable.",
    "settings.history.revealFinder": "Reveal in Finder",
    "settings.history.revealFinderFor": "Reveal {title} in Finder",
    "settings.history.deleteTooltip": "Delete",
    "settings.history.deleteItem": "Delete {title}",
    "settings.history.confirmDeleteItem": "Confirm delete {title}",
    "settings.history.deleteConfirm": "Delete",
    "settings.history.excludeApplication": "Exclude {app} from future history",
    "settings.history.includeApplication": "Include {app} in future history",
    "settings.history.futureRule": "{action} {app} for future history.",
    "settings.history.include": "Included",
    "settings.history.exclude": "Excluded",
    "settings.history.removeRule": "Remove {value}",
    "settings.history.error.load": "Unable to load history.",
    "settings.history.error.applications": "Detected apps could not be loaded",
    "settings.history.error.policy": "Unable to update policy.",
    "settings.history.error.enable": "Unable to enable history.",
    "settings.history.error.update": "Unable to update history.",
    "settings.history.error.clear": "Unable to clear history.",
    "settings.history.error.delete": "Unable to delete interval.",
    "settings.history.error.appPolicy": "Unable to update app policy.",
    "settings.history.error.newTask": "Unable to open a new task.",
    "settings.history.privacyDialog": "Privacy consent",
    "settings.history.consent.title": "You're in control.",
    "settings.history.consent.controls":
      "You can pause or clear your history and manage which apps are included at any time.",
    "settings.history.consent.sensitiveApps":
      "Consider pausing or excluding sensitive apps, such as health or finance, from your history.",
    "settings.history.consent.otherPeople":
      "Pause Computer History during communications with others unless you have their consent.",
    "settings.history.privateNote": "Private windows are excluded.",
    "settings.history.cancel": "Cancel",
    "settings.history.allowAllApps": "Allow all apps",
    "settings.history.customizeApps": "Customize apps",
    "settings.history.permissionsDialog": "Computer history permissions",
    "settings.history.permissionsDialogDescription": "Choose app and website rules.",
    "settings.history.applications": "Applications",
    "settings.history.websites": "Websites",
    "settings.history.permissionMode.excludeApps": "Exclude these apps",
    "settings.history.permissionMode.includeApps": "Include only these apps",
    "settings.history.permissionMode.excludeWebsites": "Exclude these websites",
    "settings.history.permissionMode.includeWebsites": "Include only these websites",
    "settings.history.addApp": "Add app",
    "settings.history.addWebsite": "Add website",
    "settings.history.searchApps": "Search apps",
    "settings.history.loadingApps": "Loading apps…",
    "settings.history.noApps": "No apps found",
    "settings.history.allAppsAdded": "All detected apps are added",
    "settings.history.websitePlaceholder": "Website hostname",
    "settings.history.websiteExample": "example.com",
    "settings.history.websiteDomain": "Website domain",
    "settings.history.invalidWebsite": "Enter a valid hostname.",
    "settings.history.add": "Add",
    "settings.history.save": "Save",
    "settings.history.openAppMenu": "Open {app} menu",
    "settings.history.browser.allWebsites": "All websites",
    "settings.history.browser.allButWebsite": "All but {count} website",
    "settings.history.browser.allButWebsites": "All but {count} websites",
    "settings.history.browser.noWebsites": "No websites",
    "settings.history.browser.onlyWebsite": "Only {count} website",
    "settings.history.browser.onlyWebsites": "Only {count} websites",
    "settings.history.off.example.planningDocument.link": "Q4 Launch Planning",
    "settings.history.loadingPermissions": "Loading permissions…",
    "settings.history.error.historyLoad": "Computer history could not be loaded",
    "settings.history.error.permissionsLoad": "Computer history permissions could not be loaded",
    "settings.history.permissionsRestart": "If the issue persists, please restart Moss.",
    "settings.history.privateNoteShort":
      "Private-mode web browsing activity is never included in computer history.",
    "settings.history.done": "Done",
  };
  const translate = (key: string) => copy[key] ?? key;
  const format = (key: string, values: Record<string, unknown>) =>
    translate(key).replace(/\{(\w+)\}/g, (_, name: string) => String(values[name] ?? ""));
  return { useTranslation: () => ({ t: translate, format, locale: "en" as const }) };
});

import { ComputerHistorySettingsPanel } from "./ComputerHistorySettingsPanel";

const SETTINGS = {
  consentAt: null,
  observation: {
    defaultApplicationBehavior: "allow" as const,
    defaultURLBehavior: "allow" as const,
    allowlist: [],
    blocklist: [],
    urlAllowlist: [],
    urlBlocklist: [],
  },
};

type TestState = {
  supported: boolean;
  enabled: boolean;
  recorderState: "stopped" | "running" | "paused";
  activationState: "idle" | "starting" | "waiting_for_permissions" | "failed";
  inputMonitoringPermission: "granted" | "pending" | "denied" | "restricted" | "unknown";
  accessibilityPermission: "granted" | "pending" | "denied" | "restricted" | "unknown";
  screenRecordingPermission: "granted" | "pending" | "denied" | "restricted" | "unknown";
  privateBrowsingExcluded: boolean;
  browserCapabilities: never[];
  captureCapability: {
    mode: "window_metadata_only" | "interaction_activity";
    interactionEvents: boolean;
    activitySummaries: boolean;
    detail: string;
  };
  settings: typeof SETTINGS;
  health: {
    droppedEvents: number;
    queueDepth: number;
    storageBytes: number;
    lastError: string | null;
    corruptionDetected: boolean;
    keychainState: "ready" | "locked" | "unavailable" | "unknown";
  };
  message: string | null;
};

const makeState = (overrides: Partial<TestState> = {}): TestState => ({
  supported: true,
  enabled: false,
  recorderState: "stopped" as const,
  activationState: "idle" as const,
  inputMonitoringPermission: "granted" as const,
  accessibilityPermission: "granted" as const,
  screenRecordingPermission: "granted" as const,
  privateBrowsingExcluded: true,
  browserCapabilities: [],
  captureCapability: {
    mode: "window_metadata_only" as const,
    interactionEvents: false,
    activitySummaries: false,
    detail: "Window metadata only.",
  },
  settings: SETTINGS,
  health: {
    droppedEvents: 0,
    queueDepth: 0,
    storageBytes: 0,
    lastError: null,
    corruptionDetected: false,
    keychainState: "unknown" as const,
  },
  message: null,
  ...overrides,
});

const OFF_STATE = makeState();
const ON_STATE = makeState({ enabled: true, recorderState: "running" as const });
const PAUSED_STATE = makeState({ enabled: true, recorderState: "paused" as const });
const UNSUPPORTED_STATE = makeState({ supported: false, message: null });
const TEST_APP_ICON_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

const YESTERDAY_LATE_MS = (() => {
  const date = new Date();
  date.setDate(date.getDate() - 1);
  date.setHours(23, 50, 0, 0);
  return date.getTime();
})();

const HISTORY = {
  entries: [
    {
      id: "history-1",
      summaryLevel: "ten_minute" as const,
      interval: { startMs: YESTERDAY_LATE_MS, endMs: YESTERDAY_LATE_MS + 10 * 60 * 1_000 },
      title: "Editor event",
      description: "Editor activity",
      applications: [
        {
          bundleIdentifier: "com.example.editor",
          displayName: "Editor",
          iconDataURL: TEST_APP_ICON_DATA_URL,
        },
        { bundleIdentifier: "com.example.browser", displayName: "Browser" },
      ],
      memoryFilePath: "/tmp/history-1.md",
      suggestion: {
        type: "skill" as const,
        name: "Review editor activity",
        description: "Review editor activity and make it reusable.",
      },
    },
    {
      id: "history-2",
      summaryLevel: "six_hour" as const,
      interval: {
        startMs: YESTERDAY_LATE_MS - 6 * 60 * 60 * 1_000,
        endMs: YESTERDAY_LATE_MS,
      },
      title: "Browser event",
      description: "Browser activity",
      applications: [{ bundleIdentifier: "com.example.browser", displayName: "Browser" }],
      memoryFilePath: "/tmp/history-2.md",
      suggestion: {
        type: "automation" as const,
        name: "Automate browser activity",
        description: "Automate the repeated browser activity.",
      },
    },
  ],
  nextCursor: null,
  modelContextDisclosure: { included: false, notImplicitlyInjected: true, text: "Local only." },
};

function configureApi(initialState: TestState) {
  let currentState = initialState;
  let currentSettings = initialState.settings;
  const detectedApplications = [
    {
      bundleIdentifier: "com.example.editor",
      name: "Editor",
      permitted: true,
      isWebBrowser: false,
      iconDataURL: TEST_APP_ICON_DATA_URL,
    },
    {
      bundleIdentifier: "com.example.browser",
      name: "Browser",
      permitted: true,
      isWebBrowser: true,
    },
  ];
  harness.api.computerHistory.getState.mockImplementation(async () => currentState);
  harness.api.computerHistory.getSettings.mockResolvedValue(initialState.settings);
  harness.api.computerHistory.listHistory.mockImplementation(async () =>
    currentState.enabled ? HISTORY : { ...HISTORY, entries: [] },
  );
  harness.api.computerHistory.listHistorySuggestions.mockResolvedValue({ suggestions: [] });
  harness.api.computerHistory.listApplications.mockResolvedValue({
    applications: detectedApplications,
  });
  harness.api.computerHistory.resolveApplications.mockImplementation(
    async ({ bundleIdentifiers }: { bundleIdentifiers?: string[] } = {}) => ({
      applications: detectedApplications.filter((app) =>
        (bundleIdentifiers ?? []).includes(app.bundleIdentifier),
      ),
    }),
  );
  harness.api.computerHistory.updateSettings.mockImplementation(
    async ({ settings }: { settings: typeof SETTINGS }) => {
      currentSettings = settings;
      currentState = { ...ON_STATE, settings };
      return currentState;
    },
  );
  harness.api.computerHistory.setEnabled.mockImplementation(
    async ({ enabled }: { enabled: boolean }) => {
      currentState = { ...(enabled ? ON_STATE : OFF_STATE), settings: currentSettings };
      return currentState;
    },
  );
  harness.api.computerHistory.clearHistory.mockResolvedValue({
    deletedCount: 1,
    summaryIndexRefresh: "pending",
  });
  harness.api.computerHistory.retryActivation.mockResolvedValue(initialState);
  harness.api.computerHistory.pause.mockImplementation(async () => {
    currentState = { ...PAUSED_STATE, settings: currentSettings };
    return currentState;
  });
  harness.api.computerHistory.resume.mockImplementation(async () => {
    currentState = { ...ON_STATE, settings: currentSettings };
    return currentState;
  });
  harness.api.computerHistory.revealInFinder.mockResolvedValue({ opened: true });
}

describe("ComputerHistorySettingsPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    configureApi(OFF_STATE);
    harness.api.shell.openExternal.mockResolvedValue(true);
    harness.handleNewChat.mockResolvedValue({ ok: true, threadId: "history-thread" });
  });

  afterEach(() => {
    // vitest-browser-react owns React cleanup; clearing body manually breaks
    // portalled Menu/Dialog teardown in the next case.
  });

  it("covers loading, off, and unsupported gates without diagnostic extras", async () => {
    let resolveState!: (state: typeof OFF_STATE) => void;
    harness.api.computerHistory.getState.mockReturnValue(
      new Promise((resolve) => {
        resolveState = resolve;
      }),
    );
    const screen = await render(<ComputerHistorySettingsPanel />);
    await expect.element(page.getByTestId("computer-history-loading")).toBeVisible();
    resolveState(OFF_STATE);
    await expect.element(page.getByTestId("computer-history-off-state")).toBeVisible();
    const offSurface = page
      .getByTestId("computer-history-off-state")
      .element()
      .querySelector("section");
    expect(offSurface?.className).toContain("rounded-2xl");
    expect(offSurface?.className).toContain("bg-[var(--color-background-panel)]");
    await expect.element(page.getByRole("button", { name: "Turn on" })).toBeVisible();
    expect(page.getByRole("button", { name: "Turn on" }).element().className).toContain("!h-6");
    expect(page.getByRole("button", { name: "Turn on" }).element().className).toContain("!py-0.5");
    expect(page.getByRole("button", { name: "Turn on" }).element().className).toContain("!text-ui");
    expect(
      document.querySelector("[data-computer-history-example-user]")?.getAttribute("style"),
    ).toContain("moss-computer-history-user-send");
    expect(
      Array.from(document.querySelectorAll("style")).some((style) =>
        style.textContent?.includes("prefers-reduced-motion"),
      ),
    ).toBe(true);
    expect(document.body.textContent).not.toContain("Capture scope");
    await screen.unmount();

    configureApi(UNSUPPORTED_STATE);
    const unsupported = await render(<ComputerHistorySettingsPanel />);
    await expect
      .element(page.getByText("Computer History is unavailable on this platform."))
      .toBeVisible();
    expect(
      (page.getByRole("button", { name: "Turn on" }).element() as HTMLButtonElement).disabled,
    ).toBe(true);
    await unsupported.unmount();

    configureApi(OFF_STATE);
    harness.api.computerHistory.getState.mockRejectedValue(new Error("load-failed"));
    const errorScreen = await render(<ComputerHistorySettingsPanel />);
    await expect.element(page.getByTestId("computer-history-error")).toBeVisible();
    await expect.element(page.getByRole("button", { name: "Try again" })).toBeVisible();
    await errorScreen.unmount();

    configureApi(ON_STATE);
    harness.api.computerHistory.listHistory.mockResolvedValue({ ...HISTORY, entries: [] });
    const emptyScreen = await render(<ComputerHistorySettingsPanel />);
    await expect.element(page.getByTestId("computer-history-empty")).toBeVisible();
    expect(document.body.textContent).not.toContain("Ask about your history");
    expect(document.body.textContent).not.toContain("Clear history");
    await emptyScreen.unmount();
  });

  it("supports consent cancel, allow-all, and customize handoff", async () => {
    const screen = await render(<ComputerHistorySettingsPanel />);
    const trigger = page.getByRole("button", { name: "Turn on" });
    await trigger.click();
    await expect.element(page.getByRole("dialog", { name: "You're in control." })).toBeVisible();
    expect(document.querySelector('[data-testid="computer-history-dialog"]')?.className).toContain(
      "w-[520px]",
    );
    expect(document.activeElement).toBeInstanceOf(HTMLElement);
    await page.getByRole("button", { name: "Cancel" }).click();
    await expect.element(page.getByRole("button", { name: "Turn on" })).toBeVisible();

    await trigger.click();
    await page.getByRole("button", { name: "Customize apps" }).click();
    await expect
      .element(page.getByRole("dialog", { name: "Computer history permissions" }))
      .toBeVisible();
    expect(harness.api.computerHistory.updateSettings).not.toHaveBeenCalled();
    expect(harness.api.computerHistory.setEnabled).not.toHaveBeenCalled();
    await expect.element(page.getByRole("button", { name: "Continue" })).toBeVisible();
    await page.getByRole("button", { name: "Continue" }).click();
    await expect.element(page.getByText("History", { exact: true })).toBeVisible();
    expect(harness.api.computerHistory.updateSettings).toHaveBeenCalled();
    expect(harness.api.computerHistory.setEnabled).toHaveBeenCalledWith(
      expect.objectContaining({ enabled: true }),
    );
    await screen.unmount();

    configureApi(OFF_STATE);
    const allowScreen = await render(<ComputerHistorySettingsPanel />);
    await page.getByRole("button", { name: "Turn on" }).click();
    await page.getByRole("button", { name: "Allow all apps" }).click();
    await expect.element(page.getByText("History", { exact: true })).toBeVisible();
    expect(harness.api.computerHistory.setEnabled).toHaveBeenCalledWith(
      expect.objectContaining({ enabled: true }),
    );
    await allowScreen.unmount();
  });

  it("opens Moss docs from every learn-more surface and uses parity icons", async () => {
    const offScreen = await render(<ComputerHistorySettingsPanel />);
    const offLearnMore = page.getByTestId("computer-history-off-learn-more");
    await expect.element(offLearnMore).toBeVisible();
    expect(offLearnMore.element().getAttribute("href")).toBe("https://trymoss.com/docs");
    await offLearnMore.click();
    expect(harness.api.shell.openExternal).toHaveBeenCalledWith("https://trymoss.com/docs");

    await page.getByRole("button", { name: "Turn on" }).click();
    const consent = page.getByRole("dialog", { name: "You're in control." });
    await expect.element(consent).toBeVisible();
    const controlsIcon = consent
      .element()
      .querySelector<SVGElement>('[data-testid="computer-history-consent-controls-icon"]');
    const sensitiveIcon = consent
      .element()
      .querySelector<SVGElement>('[data-testid="computer-history-consent-sensitive-icon"]');
    const otherPeopleIcon = consent
      .element()
      .querySelector<SVGElement>('[data-testid="computer-history-consent-other-people-icon"]');
    for (const icon of [controlsIcon, sensitiveIcon, otherPeopleIcon]) {
      expect(icon).not.toBeNull();
      expect(icon?.getAttribute("viewBox")).toBe("0 0 24 24");
      expect(icon?.classList.contains("mt-0.5")).toBe(false);
    }
    expect(controlsIcon?.querySelectorAll("path")).toHaveLength(6);
    expect(controlsIcon?.querySelector('path[fill="#DC7157"]')).not.toBeNull();
    expect(controlsIcon?.querySelector('path[fill="#DA816B"]')).not.toBeNull();
    expect(sensitiveIcon?.querySelectorAll("path")).toHaveLength(7);
    expect(sensitiveIcon?.querySelector('path[fill="#A93A20"]')).not.toBeNull();
    expect(sensitiveIcon?.querySelector('path[fill="#A9583D"]')).not.toBeNull();
    expect(otherPeopleIcon?.querySelectorAll("path")).toHaveLength(10);
    expect(otherPeopleIcon?.querySelector('path[fill="#608DFF"]')).not.toBeNull();
    expect(otherPeopleIcon?.querySelector('path[fill="#8EBAFF"]')).not.toBeNull();
    await page.getByRole("button", { name: "Cancel" }).click();
    await offScreen.unmount();

    configureApi(ON_STATE);
    const onScreen = await render(<ComputerHistorySettingsPanel />);
    const enabledLearnMore = page.getByTestId("computer-history-enabled-learn-more");
    await expect.element(enabledLearnMore).toBeVisible();
    expect(enabledLearnMore.element().getAttribute("href")).toBe("https://trymoss.com/docs");
    await enabledLearnMore.click();
    expect(harness.api.shell.openExternal).toHaveBeenLastCalledWith("https://trymoss.com/docs");

    await page.getByRole("button", { name: "Choose" }).click();
    const permissionsLearnMore = page.getByTestId("computer-history-permissions-learn-more");
    await expect.element(permissionsLearnMore).toBeVisible();
    expect(permissionsLearnMore.element().getAttribute("href")).toBe("https://trymoss.com/docs");
    await permissionsLearnMore.click();
    expect(harness.api.shell.openExternal).toHaveBeenLastCalledWith("https://trymoss.com/docs");
    await onScreen.unmount();
  });

  it("supports permission modes, app search, add/remove, URL normalization, save, and cancel", async () => {
    configureApi(ON_STATE);
    const screen = await render(<ComputerHistorySettingsPanel />);
    const chooseButton = page.getByRole("button", { name: "Choose" });
    await chooseButton.click();
    const permissionsDialog = page.getByRole("dialog", { name: "Computer history permissions" });
    await expect.element(permissionsDialog).toBeVisible();
    const chooseElement = document.querySelector<HTMLElement>(
      '[data-testid="computer-history-settings"] [data-slot="button"][class*="!h-7"]',
    );
    expect(chooseElement?.className).toContain("!h-7");
    expect(chooseElement?.className).toContain("!px-2");
    expect(chooseElement?.className).toContain("!text-ui-lg");
    expect(permissionsDialog.element().getAttribute("aria-labelledby")).toBeTruthy();
    expect(permissionsDialog.element().querySelectorAll('[data-slot="dialog-title"]')).toHaveLength(
      1,
    );
    expect(permissionsDialog.element().textContent).not.toContain("Choose app and website rules.");
    const permissionsGrid = permissionsDialog
      .element()
      .querySelector<HTMLElement>('[class*="grid-cols-2"]');
    expect(permissionsGrid?.className).not.toContain("mt-5");
    const permissionCards = permissionsDialog
      .element()
      .querySelectorAll<HTMLElement>('[class*="h-[250px]"]');
    expect(permissionCards).toHaveLength(2);
    for (const card of permissionCards) {
      expect(card.className).not.toContain("p-3");
      expect(card.querySelector("button")?.className).toContain("mx-1");
      expect(card.querySelector("button")?.className).toContain("!h-10");
    }

    const appMode = page.getByRole("button", { name: "Applications" });
    expect(appMode.element().querySelector("svg")?.getAttribute("viewBox")).toBe("0 0 20 21");
    await appMode.click();
    const appModeMenu = page
      .getByRole("menuitemradio", { name: "Include only these apps" })
      .element()
      .closest<HTMLElement>('[data-slot="menu-popup"]');
    expect(appModeMenu).not.toBeNull();
    expect(getComputedStyle(appModeMenu!).borderRadius).toBe("12px");
    expect(getComputedStyle(appModeMenu!).backdropFilter).toContain("blur(8px)");
    expect(getComputedStyle(appModeMenu!).boxShadow).toContain("0.5px");
    expect(getComputedStyle(appModeMenu!).minWidth).toBe("220px");
    await page.getByRole("menuitemradio", { name: "Include only these apps" }).click();
    expect(harness.api.computerHistory.listApplications).not.toHaveBeenCalled();
    const addAppButton = page.getByRole("button", { name: "Add app" });
    expect(addAppButton.element().querySelector("svg")?.getAttribute("viewBox")).toBe("0 0 20 20");
    expect(addAppButton.element().querySelector("path")?.getAttribute("d")).toContain(
      "M9.33496 16.5V10.665",
    );
    await addAppButton.click();
    const appSearch = page.getByRole("searchbox", { name: "Search apps" });
    const appPicker = page.getByRole("listbox").element();
    const appSearchIcon = appPicker.querySelector("svg");
    expect(appSearchIcon?.getAttribute("viewBox")).toBe("0 0 16 16");
    expect(appSearchIcon?.getBoundingClientRect().width).toBe(14);
    expect(appPicker.className).toContain("bg-[var(--color-surface-elevated-secondary)]/90");
    expect(appPicker.className).toContain("ring-[0.5px]");
    expect(appPicker.className).toContain("rounded-xl");
    expect(getComputedStyle(appPicker).backdropFilter).toContain("blur(8px)");
    expect(getComputedStyle(appPicker).boxShadow).toContain("0.5px");
    await vi.waitFor(() =>
      expect(harness.api.computerHistory.listApplications).toHaveBeenCalledOnce(),
    );
    await appSearch.fill("Editor");
    expect(
      page
        .getByRole("option", { name: /Editor/ })
        .element()
        .querySelector("img")
        ?.getAttribute("src"),
    ).toBe(TEST_APP_ICON_DATA_URL);
    await userEvent.keyboard("{ArrowDown}");
    expect(page.getByRole("listbox").element().getAttribute("aria-activedescendant")).toContain(
      "com-example-editor",
    );
    await userEvent.keyboard("{Enter}");
    await expect.element(page.getByText("Editor", { exact: true })).toBeVisible();
    const removeEditor = page.getByRole("button", { name: "Remove Editor" });
    expect(removeEditor.element().querySelector("svg")?.getAttribute("viewBox")).toBe("0 0 21 21");
    await removeEditor.click();
    expect(document.querySelectorAll('button[aria-label="Remove Editor"]')).toHaveLength(0);
    await page.getByRole("button", { name: "Add app" }).click();
    await expect.element(page.getByRole("option", { name: /Editor/ })).toBeVisible();
    expect(harness.api.computerHistory.listApplications).toHaveBeenCalledOnce();
    expect(page.getByRole("listbox").element().textContent).not.toContain("com.example.editor");
    document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    await vi.waitFor(() => expect(document.querySelector('[role="listbox"]')).toBeNull());

    await page.getByRole("button", { name: "Add website" }).click();
    const website = page.getByRole("textbox", { name: "Website domain" });
    expect(website.element().closest("form")?.querySelector("svg")?.getAttribute("viewBox")).toBe(
      "0 0 20 20",
    );
    await website.fill("not a domain");
    await userEvent.keyboard("{Enter}");
    await expect.element(page.getByText("Enter a valid hostname.", { exact: true })).toBeVisible();
    await website.fill("HTTPS://Example.com/path");
    await userEvent.keyboard("{Enter}");
    await expect.element(page.getByText("example.com", { exact: true })).toBeVisible();
    const websiteRule = page.getByTestId("computer-history-website-rule");
    expect(websiteRule.element().querySelector("svg")?.getAttribute("viewBox")).toBe("0 0 20 20");
    expect(websiteRule.element().querySelector("svg")?.getBoundingClientRect().width).toBe(16);
    await page.getByRole("button", { name: "Remove example.com" }).click();
    await page.getByRole("button", { name: "Done" }).click();
    const saved = harness.api.computerHistory.updateSettings.mock.lastCall?.[0]?.settings;
    expect(saved?.observation.defaultApplicationBehavior).toBe("block");
    expect(saved?.observation.defaultURLBehavior).toBe("allow");
    await screen.unmount();
  });

  it("portals and scrolls the full 219-app catalog with collision-safe placement", async () => {
    configureApi(ON_STATE);
    const applications = Array.from({ length: 219 }, (_, index) => ({
      bundleIdentifier: `com.example.app-${index}`,
      name: `App ${index}`,
      permitted: true,
      isWebBrowser: false,
    }));
    harness.api.computerHistory.listApplications.mockResolvedValue({ applications });
    const screen = await render(<ComputerHistorySettingsPanel />);
    await page.viewport(800, 600);
    await page.getByRole("button", { name: "Choose" }).click();
    const addApp = page.getByRole("button", { name: "Add app" });
    vi.spyOn(addApp.element(), "getBoundingClientRect").mockReturnValue({
      x: 760,
      y: 560,
      left: 760,
      top: 560,
      right: 800,
      bottom: 590,
      width: 40,
      height: 30,
      toJSON: () => ({}),
    } as DOMRect);
    await addApp.click();
    await vi.waitFor(() => expect(page.getByRole("option").length).toBe(219));
    const picker = page.getByRole("listbox").element();
    const dialog = page.getByRole("dialog", { name: "Computer history permissions" }).element();
    expect(getComputedStyle(dialog).transform).toBe("none");
    expect(getComputedStyle(picker).position).toBe("fixed");
    expect(picker.parentElement).toBe(dialog);
    expect(picker.closest("[data-computer-history-dialog-scroll-owner]")).toBeNull();
    expect(picker.className).toContain("overflow-y-auto");
    expect(picker.className).toContain("max-h-[min(350px,calc(100vh-16px))]");
    expect(Number.parseFloat(picker.style.left)).toBeLessThanOrEqual(554);
    expect(Number.parseFloat(picker.style.top)).toBeLessThan(560);
    const pickerRect = picker.getBoundingClientRect();
    expect(pickerRect.right).toBeLessThanOrEqual(window.innerWidth - 5);
    expect(pickerRect.bottom).toBeLessThanOrEqual(window.innerHeight - 5);
    expect(picker.querySelector('[data-active="true"]')).toBeNull();
    const scrollIntoViewSpy = vi
      .spyOn(HTMLElement.prototype, "scrollIntoView")
      .mockImplementation(() => {});
    const searchbox = page.getByRole("searchbox", { name: "Search apps" });
    await userEvent.keyboard("{ArrowUp}");
    expect(picker.querySelector('[data-active="true"]')?.id).toContain("app-218");
    expect(scrollIntoViewSpy).toHaveBeenCalled();
    await searchbox.fill("App 218");
    await expect.element(page.getByRole("option", { name: "App 218" })).toBeVisible();
    expect(picker.querySelector('[data-active="true"]')).toBeNull();
    await searchbox.fill("App 0");
    await userEvent.keyboard("{ArrowDown}");
    expect(picker.querySelector('[data-active="true"]')?.id).toContain("app-0");
    await userEvent.keyboard("{Escape}");
    await vi.waitFor(() => expect(document.querySelector('[role="listbox"]')).toBeNull());
    scrollIntoViewSpy.mockRestore();
    await page.viewport(1760, 916);
    await screen.unmount();
  });

  it("renders paused state and timeline day groups with 68px rail and delete/reveal actions", async () => {
    configureApi(PAUSED_STATE);
    const screen = await render(<ComputerHistorySettingsPanel />);
    const resumeButton = page.getByRole("button", { name: "Resume" });
    await expect.element(resumeButton).toBeVisible();
    expect(resumeButton.element().className).toContain("text-[var(--color-text-foreground)]");
    expect(resumeButton.element().className).toContain(
      "bg-[color-mix(in_srgb,var(--color-text-foreground)_5%,transparent)]",
    );
    expect(resumeButton.element().className).toContain("!py-0.5");
    const settingsSurface = page.getByTestId("computer-history-settings").element();
    expect(settingsSurface.firstElementChild?.className).toContain("rounded-2xl");
    expect(settingsSurface.firstElementChild?.className).toContain("border");
    expect(settingsSurface.firstElementChild?.getAttribute("style")).toContain(
      "background-color: var(--color-background-panel, var(--color-background-primary-soft-alpha))",
    );
    expect(
      settingsSurface.firstElementChild?.querySelector<HTMLElement>(
        '[data-slot="settings-row"] > div:last-child',
      )?.className,
    ).toContain("gap-3");
    const firstSettingsRow = settingsSurface.firstElementChild?.querySelector<HTMLElement>(
      '[data-slot="settings-row"]',
    );
    const firstSettingsRowText = firstSettingsRow?.firstElementChild?.firstElementChild;
    expect(firstSettingsRowText?.firstElementChild?.className).toContain("text-ui");
    expect(firstSettingsRowText?.firstElementChild?.className).toContain("leading-[18px]");
    expect(firstSettingsRowText?.lastElementChild?.className).toContain(
      "text-[var(--color-text-foreground-secondary)]",
    );
    const timeline = page.getByTestId("computer-history-timeline");
    expect(
      page.getByTestId("computer-history-history-section").element().firstElementChild?.className,
    ).toContain("min-h-toolbar");
    expect(timeline.element().parentElement?.className).toContain("rounded-2xl");
    expect(timeline.element().parentElement?.className).toContain(
      "bg-[var(--color-background-panel)]",
    );
    const entries = page.getByTestId("computer-history-entry");
    expect(entries.length).toBe(2);
    await expect.element(entries.first()).toBeVisible();
    const editorIcon = entries.first().element().querySelector("img");
    expect(editorIcon?.getAttribute("src")).toBe(TEST_APP_ICON_DATA_URL);
    const sixHourTime = entries.all()[1]?.element().querySelector('[data-history-time="six_hour"]');
    expect(sixHourTime?.textContent).toBe("Evening");
    expect(sixHourTime?.className).toContain("pt-[14px]");
    const clearHistory = page.getByRole("button", { name: "Clear history" });
    expect(clearHistory.element().className).toContain("!px-3");
    expect(clearHistory.element().querySelector("svg")?.getAttribute("viewBox")).toBe("0 0 20 21");
    const askButton = page.getByRole("button", { name: "Ask about your history" });
    expect(askButton.element().className).toContain("!h-7");
    const askIcon = askButton.element().querySelector("svg");
    expect(askIcon?.getAttribute("viewBox")).toBe("0 0 14 12");
    expect(askIcon?.getAttribute("width")).toBe("14");
    expect(askIcon?.getAttribute("height")).toBe("12");
    const historyInfo = page.getByRole("button", { name: "About computer history" });
    expect(historyInfo.element().className).toContain("size-4");
    expect(historyInfo.element().className).toContain("cursor-interaction");
    expect(historyInfo.element().className).toContain("text-tertiary");
    expect(historyInfo.element().querySelector("svg")?.getAttribute("viewBox")).toBe("0 0 21 21");
    expect(historyInfo.element().querySelectorAll("svg path")).toHaveLength(3);
    const previousRuntime = document.documentElement.dataset.runtime;
    document.documentElement.dataset.runtime = "electron";
    expect(getComputedStyle(historyInfo.element()).cursor).toBe("default");
    delete document.documentElement.dataset.runtime;
    expect(getComputedStyle(historyInfo.element()).cursor).toBe("pointer");
    if (previousRuntime) document.documentElement.dataset.runtime = previousRuntime;
    await userEvent.hover(sixHourTime as HTMLElement);
    await vi.waitFor(() =>
      expect(document.querySelector('[data-slot="tooltip-popup"]')?.textContent).toContain(" – "),
    );
    expect(
      entries
        .first()
        .element()
        .querySelector('[data-history-time="ten_minute"]')
        ?.getAttribute("title"),
    ).toBeNull();
    await userEvent.unhover(sixHourTime as HTMLElement);
    expect(entries.all()[1]?.element().querySelector("img")).toBeNull();
    for (const entry of entries.all()) {
      expect(entry.element().className).toContain("grid-cols-[68px_1px_minmax(0,1fr)]");
      expect(entry.element().querySelector("[data-history-rail-dot]")).not.toBeNull();
      expect(entry.element().querySelector("[data-history-rail-before]")?.className).toContain(
        "h-[17px]",
      );
      expect(entry.element().querySelector("[data-history-rail-after]")?.className).toContain(
        "top-[27px]",
      );
    }
    expect(
      entries.first().element().querySelector("[data-history-rail-before]")?.className,
    ).toContain("hidden");
    expect(
      entries.all()[1]?.element().querySelector("[data-history-rail-after]")?.className,
    ).toContain("hidden");
    const editorButton = page.getByRole("button", { name: "Open Editor menu", exact: true });
    expect(editorButton.element().className).not.toContain("ring-primary");
    expect(editorButton.element().className).toContain("rounded-inline");
    expect(editorButton.element().className).toContain("duration-[120ms]");
    expect(
      entries
        .all()[1]
        ?.element()
        .querySelector('[data-testid="computer-history-entry-apps"] span[aria-hidden="true"]')
        ?.textContent,
    ).toBe("B");
    editorButton.element().dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    await vi.waitFor(() =>
      expect(entries.all()[1]?.element().querySelector("article")?.className).toContain(
        "opacity-40",
      ),
    );
    editorButton.element().dispatchEvent(new MouseEvent("mouseout", { bubbles: true }));
    await vi.waitFor(() =>
      expect(entries.all()[1]?.element().querySelector("article")?.className).not.toContain(
        "opacity-40",
      ),
    );
    await editorButton.click();
    const appMenuShell = document.querySelector<HTMLElement>('[data-slot="menu-popup"]');
    expect(appMenuShell?.className).toContain("min-w-[180px]");
    expect(
      page.getByRole("menuitem", { name: "Exclude Editor from future history" }).element(),
    ).toBeTruthy();
    await page.getByRole("menuitem", { name: "Exclude Editor from future history" }).click();
    const buttonLabels = Array.from(document.querySelectorAll("button"), (button) =>
      button.textContent?.trim(),
    );
    expect(buttonLabels).not.toContain("10 minutes");
    expect(buttonLabels).not.toContain("6 hours");
    const group = page.getByRole("button", { name: "Yesterday" });
    const dayChevron = group.element().querySelector("svg");
    expect(dayChevron?.getAttribute("viewBox")).toBe("0 0 20 20");
    expect(dayChevron?.getBoundingClientRect().width).toBe(16);
    expect(dayChevron?.className.baseVal).toContain("rotate-90");
    await group.click();
    expect((group.element() as HTMLButtonElement).getAttribute("aria-expanded")).toBe("false");
    expect(dayChevron?.className.baseVal).not.toContain("rotate-90");
    await group.click();
    expect(dayChevron?.className.baseVal).toContain("rotate-90");

    const revealButton = page
      .getByRole("button", { name: "Reveal Editor event in Finder" })
      .first();
    expect(revealButton.element().className).toContain("size-5.5");
    const revealIcon = revealButton.element().querySelector("svg");
    expect(revealIcon?.getAttribute("viewBox")).toBe("0 0 20 20");
    expect(revealIcon?.querySelector("path")?.getAttribute("d")).toContain(
      "M16.6182 9.33203H3.38184",
    );
    await userEvent.hover(revealButton.element());
    await vi.waitFor(() =>
      expect(document.querySelector('[data-slot="tooltip-popup"]')?.textContent).toBe(
        "Reveal in Finder",
      ),
    );
    await userEvent.unhover(revealButton.element());
    revealButton.element().focus();
    await revealButton.click();
    expect(document.activeElement).not.toBe(revealButton.element());
    expect(harness.api.computerHistory.revealInFinder).toHaveBeenCalledWith({
      entryId: "history-1",
    });
    const deleteButton = page.getByRole("button", { name: "Delete Editor event" });
    expect(deleteButton.element().getAttribute("style")).toContain("width 0.16s");
    expect(deleteButton.element().className).toContain("w-5.5");
    const deleteIcon = deleteButton.element().querySelector("svg");
    expect(deleteIcon?.getAttribute("viewBox")).toBe("0 0 20 20");
    expect(deleteIcon?.querySelector("path")?.getAttribute("d")).toContain(
      "M10.6299 1.33496C12.0335",
    );
    await userEvent.hover(deleteButton.element());
    await vi.waitFor(() =>
      expect(document.querySelector('[data-slot="tooltip-popup"]')?.textContent).toBe("Delete"),
    );
    await deleteButton.click();
    await vi.waitFor(() =>
      expect(document.querySelector('[data-slot="tooltip-popup"]')).toBeNull(),
    );
    expect(
      page.getByRole("button", { name: "Confirm delete Editor event" }).element().className,
    ).toContain("w-14");
    await page.getByRole("button", { name: "Confirm delete Editor event" }).click();
    expect(harness.api.computerHistory.clearHistory).toHaveBeenCalledWith(
      expect.objectContaining({
        intervalStartMs: HISTORY.entries[0]!.interval.startMs,
        intervalEndMs: HISTORY.entries[0]!.interval.endMs,
      }),
    );
    await screen.unmount();

    const waitingState = makeState({
      enabled: true,
      recorderState: "stopped",
      activationState: "waiting_for_permissions",
    });
    configureApi(waitingState);
    const waitingScreen = await render(<ComputerHistorySettingsPanel />);
    await expect.element(page.getByRole("button", { name: "Finish setup" })).toBeVisible();
    await expect.element(page.getByRole("button", { name: "Choose" })).toBeVisible();
    await waitingScreen.unmount();
  });

  it("covers clear scopes, ask composer handoff, and suggestion handoff", async () => {
    configureApi(ON_STATE);
    const random = vi.spyOn(Math, "random").mockReturnValue(0);
    const screen = await render(<ComputerHistorySettingsPanel />);
    await page.getByRole("button", { name: "Clear history" }).click();
    await expect
      .element(page.getByRole("menuitem", { name: "Clear last 10 minutes" }))
      .toBeVisible();
    await expect.element(page.getByRole("menuitem", { name: "Clear last hour" })).toBeVisible();
    await expect.element(page.getByRole("menuitem", { name: "Clear last day" })).toBeVisible();
    await expect.element(page.getByRole("menuitem", { name: "Clear all" })).toBeVisible();
    expect(
      page.getByRole("menuitem", { name: "Clear all" }).element().getAttribute("data-variant"),
    ).toBe("destructive");
    expect(
      page
        .getByRole("menuitem", { name: "Clear last hour" })
        .element()
        .getAttribute("data-variant"),
    ).toBe("default");
    for (const [menuLabel, question] of [
      ["Clear last 10 minutes", "Clear the last 10 minutes?"],
      ["Clear last hour", "Clear the last hour?"],
      ["Clear last day", "Clear the last day?"],
    ] as const) {
      await page.getByRole("menuitem", { name: menuLabel }).click();
      const scopedDialog = page.getByRole("dialog", { name: "Clear history" });
      await expect.element(scopedDialog.getByText(question, { exact: true })).toBeVisible();
      await scopedDialog.getByRole("button", { name: "Cancel" }).click();
      await page.getByRole("button", { name: "Clear history" }).click();
    }
    await page.getByRole("menuitem", { name: "Clear all" }).click();
    const clearDialog = page.getByRole("dialog", { name: "Clear history" });
    await expect.element(clearDialog).toBeVisible();
    await expect
      .element(clearDialog.getByText("Clear all history?", { exact: true }))
      .toBeVisible();
    await expect
      .element(
        clearDialog.getByText(
          "Your actions and any memories created from them will be deleted. This cannot be undone.",
          { exact: true },
        ),
      )
      .toBeVisible();
    await expect.element(clearDialog.getByRole("button", { name: "Close" })).toBeVisible();
    await clearDialog.getByRole("button", { name: "Clear" }).click();
    expect(harness.api.computerHistory.clearHistory).toHaveBeenCalledWith({ scope: "all" });
    expect(harness.toastAdd).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "success",
        title: "History cleared — Moss memory may take up to 6 hours to update",
      }),
    );

    const historyCallsBeforeAsk = harness.api.computerHistory.listHistory.mock.calls.length;
    await page.getByRole("button", { name: "Ask about your history" }).click();
    expect(harness.api.computerHistory.listHistory.mock.calls.length).toBe(historyCallsBeforeAsk);
    expect(harness.api.computerHistory.listHistorySuggestions).not.toHaveBeenCalled();
    expect(harness.handleNewChat).toHaveBeenCalledWith({ fresh: true });
    expect(harness.setPrompt).toHaveBeenCalledWith(
      "history-thread",
      "@moss://computer-history Give me a list of tasks I’ve worked on today and their status",
    );
    expect(harness.setMentions).toHaveBeenCalledWith("history-thread", [
      { name: "Computer History", path: "moss://computer-history" },
    ]);
    await expect
      .element(page.getByRole("button", { name: "Create Review editor activity skill" }))
      .toBeVisible();
    await expect.element(page.getByText("Suggested skill", { exact: true })).toBeVisible();
    await expect.element(page.getByText("Suggested automation", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Create Review editor activity skill" }).click();
    expect(harness.setPrompt).toHaveBeenCalledWith(
      "history-thread",
      '@moss://computer-history Create a new "Review editor activity" skill based on the description below. Consult the memory at /tmp/history-1.md and the events.jsonl files cited there to understand the recorded workflow and my actions.\n\n"Review editor activity and make it reusable."',
    );
    expect(harness.setMentions).toHaveBeenCalledWith("history-thread", [
      { name: "Computer History", path: "moss://computer-history" },
    ]);
    await page.getByRole("button", { name: "Create Automate browser activity automation" }).click();
    expect(harness.setPrompt).toHaveBeenCalledWith(
      "history-thread",
      '@moss://computer-history Create a new "Automate browser activity" automation based on the description below. Consult the memory at /tmp/history-2.md and the events.jsonl files cited there to understand the recorded workflow and my actions.\n\n"Automate the repeated browser activity."\n\nUse my local timezone and a new chat for scheduled runs.',
    );
    random.mockRestore();
    await screen.unmount();
  });

  it("restores focus on Escape and supports keyboard-only popup dismissal", async () => {
    configureApi(ON_STATE);
    const screen = await render(<ComputerHistorySettingsPanel />);
    const choose = page.getByRole("button", { name: "Choose" });
    await choose.click();
    await expect
      .element(page.getByRole("dialog", { name: "Computer history permissions" }))
      .toBeVisible();
    const dialog = document.querySelector<HTMLElement>('[data-testid="computer-history-dialog"]');
    expect(dialog?.className).toContain("!transition-none");
    expect(dialog?.className).toContain("!duration-0");
    expect(dialog?.className).toContain("computer-history-dialog-popup");
    expect(dialog?.className).toContain("data-starting-style:!scale-100");
    expect(dialog?.className).toContain("data-ending-style:!opacity-100");
    const dialogStyle = getComputedStyle(dialog!);
    expect(dialogStyle.transitionDuration).toBe("0s");
    expect(dialogStyle.transform).toBe("none");
    expect(dialogStyle.translate).toBe("none");
    expect(dialogStyle.scale).toBe("none");
    expect(dialogStyle.willChange).toBe("auto");
    expect(dialogStyle.opacity).toBe("1");
    expect(dialogStyle.boxShadow).toContain("0px 4px 8px -2px");
    expect(dialogStyle.boxShadow).toContain("rgba(0, 0, 0, 0.1)");
    expect(document.querySelector('[data-testid="computer-history-dialog"]')?.className).toContain(
      "motion-reduce:transition-none",
    );
    expect(document.querySelector('[data-testid="computer-history-dialog"]')?.className).toContain(
      "rounded-dialog",
    );
    expect(document.querySelector('[data-testid="computer-history-dialog"]')?.className).toContain(
      "w-[680px]",
    );
    expect(document.querySelector('[data-testid="computer-history-dialog"]')?.className).toContain(
      "bg-[var(--color-surface-elevated-secondary)]/90",
    );
    expect(document.querySelector('[data-testid="computer-history-dialog"]')?.className).toContain(
      "ring-[0.5px]",
    );
    expect(document.querySelector('[data-slot="dialog-backdrop"]')?.className).toContain(
      "bg-[#00000022]",
    );
    const focusable = dialog
      ? Array.from(
          dialog.querySelectorAll<HTMLElement>(
            "button:not([disabled]), input:not([disabled]), select:not([disabled])",
          ),
        )
      : [];
    focusable.at(-1)?.focus();
    await userEvent.tab();
    expect(document.activeElement).toBe(focusable[0]);
    await userEvent.keyboard("{Escape}");
    await vi.waitFor(() =>
      expect(document.querySelector('[data-testid="computer-history-dialog"]')).toBeNull(),
    );
    expect(document.activeElement).toBe(choose.element());

    await choose.click();
    const overlay = Array.from(
      document.querySelectorAll<HTMLElement>('[data-slot="dialog-backdrop"]'),
    ).find((candidate) => !candidate.hidden);
    overlay?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 }));
    overlay?.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, button: 0 }));
    overlay?.dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0 }));
    await vi.waitFor(() =>
      expect(document.querySelector('[data-testid="computer-history-dialog"]')).toBeNull(),
    );
    await choose.click();
    await page.getByRole("button", { name: "Add app" }).click();
    const searchbox = page.getByRole("searchbox", { name: "Search apps" });
    await expect.element(searchbox).toBeVisible();
    await searchbox.click();
    const picker = document.querySelector<HTMLElement>('[role="listbox"]');
    const reopenedDialog = document.querySelector<HTMLElement>(
      '[data-testid="computer-history-dialog"]',
    );
    expect(picker).toBeTruthy();
    expect(picker?.className).toContain("fixed");
    expect(picker?.className).toContain("w-[240px]");
    expect(picker?.className).toContain("backdrop-blur-sm");
    expect(getComputedStyle(picker!).position).toBe("fixed");
    expect(picker?.parentElement).toBe(reopenedDialog);
    expect(picker?.closest('[data-testid="computer-history-dialog-scroll-owner"]')).toBeNull();
    expect(picker?.closest('[data-testid="computer-history-dialog"]')).not.toBeNull();
    expect(reopenedDialog?.scrollTop).toBe(0);
    await userEvent.keyboard("{Escape}");
    await vi.waitFor(() => expect(document.querySelector('[role="listbox"]')).toBeNull(), {
      timeout: 2_000,
    });
    await vi.waitFor(() =>
      expect(document.activeElement).toBe(page.getByRole("button", { name: "Add app" }).element()),
    );
    await userEvent.keyboard("{Escape}");
    await vi.waitFor(() =>
      expect(document.querySelector('[data-testid="computer-history-dialog"]')).toBeNull(),
    );
    await screen.unmount();
  });

  it("refreshes history on window focus and replaces a failed timeline with retry", async () => {
    configureApi(ON_STATE);
    const intervalSpy = vi.spyOn(window, "setInterval");
    const clearIntervalSpy = vi.spyOn(window, "clearInterval");
    const screen = await render(<ComputerHistorySettingsPanel />);
    await expect.element(page.getByText("Editor event", { exact: true })).toBeVisible();
    const pollingCallIndex = intervalSpy.mock.calls.findIndex(([, delay]) => delay === 10_000);
    expect(pollingCallIndex).toBeGreaterThanOrEqual(0);
    const pollingCallback = intervalSpy.mock.calls[pollingCallIndex]?.[0];
    const pollingTimer = intervalSpy.mock.results[pollingCallIndex]?.value;
    const callsBeforePoll = harness.api.computerHistory.listHistory.mock.calls.length;
    if (typeof pollingCallback === "function") pollingCallback();
    await vi.waitFor(() =>
      expect(harness.api.computerHistory.listHistory.mock.calls.length).toBeGreaterThan(
        callsBeforePoll,
      ),
    );
    const callsBeforeFocus = harness.api.computerHistory.listHistory.mock.calls.length;
    harness.api.computerHistory.listHistory.mockRejectedValueOnce(new Error("history-failed"));
    window.dispatchEvent(new Event("focus"));
    await expect
      .element(page.getByText("Computer history could not be loaded", { exact: true }))
      .toBeVisible();
    expect(document.body.textContent).not.toContain("Editor event");
    expect(harness.api.computerHistory.listHistory.mock.calls.length).toBeGreaterThan(
      callsBeforeFocus,
    );
    await page.getByRole("button", { name: "Try again" }).click();
    await expect.element(page.getByText("Editor event", { exact: true })).toBeVisible();
    await screen.unmount();
    expect(clearIntervalSpy).toHaveBeenCalledWith(pollingTimer);
    intervalSpy.mockRestore();
    clearIntervalSpy.mockRestore();
  });

  it("loads permissions first and exposes native error codes with a retry", async () => {
    configureApi(ON_STATE);
    harness.api.computerHistory.getSettings.mockRejectedValueOnce(
      new Error("AEGetDesc failed with -1743"),
    );
    const screen = await render(<ComputerHistorySettingsPanel />);
    await page.getByRole("button", { name: "Choose" }).click();
    await expect
      .element(
        page.getByText("Computer history permissions could not be loaded (error -1743).", {
          exact: true,
        }),
      )
      .toBeVisible();
    await expect
      .element(page.getByText("If the issue persists, please restart Moss.", { exact: true }))
      .toBeVisible();
    await page.getByRole("button", { name: "Try again" }).click();
    await expect.element(page.getByRole("button", { name: "Add app" })).toBeVisible();
    expect(harness.api.computerHistory.getSettings).toHaveBeenCalled();
    expect(harness.api.computerHistory.resolveApplications).toHaveBeenCalledWith({
      bundleIdentifiers: [],
    });
    await screen.unmount();
  });

  it("keeps the permissions window in a whole-window loading state before cards", async () => {
    configureApi(ON_STATE);
    let resolveSettings!: (settings: typeof SETTINGS) => void;
    harness.api.computerHistory.getSettings.mockReturnValue(
      new Promise((resolve) => {
        resolveSettings = resolve;
      }),
    );
    const screen = await render(<ComputerHistorySettingsPanel />);
    await page.getByRole("button", { name: "Choose" }).click();
    await expect.element(page.getByText("Loading permissions…", { exact: true })).toBeVisible();
    expect(document.body.textContent).not.toContain("Add app");
    resolveSettings(SETTINGS);
    await expect.element(page.getByRole("button", { name: "Add app" })).toBeVisible();
    await screen.unmount();
  });

  it("renders selected browser metadata, subtitle matrix, and preserves permission rows", async () => {
    configureApi(ON_STATE);
    const settingsWithBrowser = {
      ...SETTINGS,
      observation: {
        ...SETTINGS.observation,
        defaultApplicationBehavior: "block" as const,
        allowlist: ["com.example.browser"],
        defaultURLBehavior: "allow" as const,
      },
    };
    harness.api.computerHistory.getSettings.mockResolvedValue(settingsWithBrowser);
    const screen = await render(<ComputerHistorySettingsPanel />);
    await page.getByRole("button", { name: "Choose" }).click();
    await expect.element(page.getByText("Browser", { exact: true })).toBeVisible();
    expect(harness.api.computerHistory.resolveApplications).toHaveBeenCalledWith({
      bundleIdentifiers: ["com.example.browser"],
    });
    await expect.element(page.getByText("All websites", { exact: true })).toBeVisible();
    expect(document.body.textContent).not.toContain("No apps selected");
    expect(document.body.textContent).not.toContain("No websites selected");
    await page.getByRole("button", { name: "Add website" }).click();
    const website = page.getByRole("textbox", { name: "Website domain" });
    await website.fill("example.com");
    await userEvent.keyboard("{Enter}");
    await expect.element(page.getByText("All but 1 website", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Add app" }).click();
    const pickerSearch = page.getByRole("searchbox", { name: "Search apps" });
    await pickerSearch.fill("does-not-exist");
    await expect.element(page.getByText("No apps found", { exact: true })).toBeVisible();
    await pickerSearch.fill("Editor");
    await page.getByRole("option", { name: /Editor/ }).click();
    await page.getByRole("button", { name: "Add app" }).click();
    await expect
      .element(page.getByText("All detected apps are added", { exact: true }))
      .toBeVisible();
    await page.getByRole("button", { name: "Add app" }).click();
    await page.getByRole("button", { name: "Websites" }).click();
    await vi.waitFor(() => expect(document.querySelector('[role="listbox"]')).toBeNull());
    const websiteMode = page.getByRole("menuitemradio", {
      name: "Include only these websites",
    });
    await expect.element(websiteMode).toBeVisible();
    expect(document.querySelector('[data-slot="menu-popup"]')).not.toBeNull();
    expect(document.activeElement).not.toBe(
      document.querySelector('[data-testid="computer-history-dialog"]'),
    );
    expect(document.activeElement?.matches("button, [role=menu]")).toBe(true);
    await websiteMode.click();
    await expect.element(page.getByText("Only 1 website", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Applications" }).click();
    await page.getByRole("menuitemradio", { name: "Exclude these apps" }).click();
    await expect.element(page.getByText("Browser", { exact: true })).toBeVisible();
    await screen.unmount();
  });

  it("keeps the off-state carousel accessible across target viewports", async () => {
    configureApi(OFF_STATE);
    const screen = await render(<ComputerHistorySettingsPanel />);
    for (const [width, height] of [
      [1760, 916],
      [768, 900],
      [375, 812],
    ] as const) {
      await page.viewport(width, height);
      await expect.element(page.getByTestId("computer-history-off-state")).toBeVisible();
      expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
    }
    await screen.unmount();
  });

  it("matches the carousel cadence, keyed remount, reduced-motion stop, and planning link", async () => {
    configureApi(OFF_STATE);
    const timeoutSpy = vi.spyOn(window, "setTimeout");
    const screen = await render(<ComputerHistorySettingsPanel />);
    const initialLabel = page.getByRole("status", { name: "Example 1 of 4" });
    await expect.element(initialLabel).toBeVisible();
    const firstUserNode = document.querySelector<HTMLElement>(
      "[data-computer-history-example-user]",
    );
    const userAnimation = firstUserNode?.getAttribute("style");
    expect(userAnimation).toContain("moss-computer-history-user-send");
    expect(userAnimation).toContain("var(--transition-duration-basic");
    const firstWordNodes = document.querySelectorAll<HTMLElement>(
      "[data-computer-history-example-word]",
    );
    expect(firstWordNodes[0]?.getAttribute("style")).toContain(
      "var(--transition-duration-relaxed, .3s) + var(--transition-duration-basic, .15s)",
    );
    expect(firstWordNodes[1]?.getAttribute("style")).toContain("75ms");
    expect(
      Array.from(firstWordNodes).some((node) => node.getAttribute("style")?.includes("1 * 75ms")),
    ).toBe(true);
    const previousExample = page.getByRole("button", { name: "Previous example" });
    const nextExample = page.getByRole("button", { name: "Next example" });
    expect(previousExample.element().querySelector("svg")?.getAttribute("viewBox")).toBe(
      "0 0 20 20",
    );
    expect(previousExample.element().querySelector("svg")?.getBoundingClientRect().width).toBe(15);
    expect(nextExample.element().querySelector("svg")?.className.baseVal).toContain("-scale-x-100");
    const carouselTimer = timeoutSpy.mock.calls.find(([, delay]) => delay === 14_000)?.[0];
    expect(carouselTimer).toBeTypeOf("function");
    (carouselTimer as (() => void) | undefined)?.();
    await expect.element(page.getByRole("status", { name: "Example 2 of 4" })).toBeVisible();
    expect(document.querySelector("[data-computer-history-example-user]")).not.toBe(firstUserNode);
    expect(document.querySelector("[data-computer-history-example-user]")?.textContent).toContain(
      "What was I working on before lunch?",
    );
    await page.getByRole("button", { name: "Next example" }).click();
    await expect.element(page.getByText("Q4 Launch Planning", { exact: true })).toBeVisible();
    expect(
      document.querySelector("[data-computer-history-example-word]")?.textContent,
    ).toBeTruthy();
    await screen.unmount();
    timeoutSpy.mockRestore();

    const originalMatchMedia = window.matchMedia;
    const mediaSpy = vi.spyOn(window, "matchMedia").mockImplementation((query) => {
      const matches = query === "(prefers-reduced-motion: reduce)";
      return {
        matches,
        media: query,
        onchange: null,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
        dispatchEvent: () => false,
      } as MediaQueryList;
    });
    const reducedTimeoutSpy = vi.spyOn(window, "setTimeout");
    const reducedScreen = await render(<ComputerHistorySettingsPanel />);
    await expect.element(page.getByRole("status", { name: "Example 1 of 4" })).toBeVisible();
    expect(reducedTimeoutSpy.mock.calls.some(([, delay]) => delay === 14_000)).toBe(false);
    await reducedScreen.unmount();
    reducedTimeoutSpy.mockRestore();
    mediaSpy.mockRestore();
    window.matchMedia = originalMatchMedia;
  });

  it("keeps dark mode and the source panel within narrow viewport bounds", async () => {
    configureApi(OFF_STATE);
    document.documentElement.classList.add("dark");
    const screen = await render(<ComputerHistorySettingsPanel />);
    for (const [width, height] of [
      [1760, 916],
      [768, 900],
      [375, 812],
    ] as const) {
      await page.viewport(width, height);
      await expect.element(page.getByTestId("computer-history-off-state")).toBeVisible();
      expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
    }
    document.documentElement.classList.remove("dark");
    await screen.unmount();
  });

  it("closes delete confirmation on Escape/outside click and uses the danger transition", async () => {
    configureApi(PAUSED_STATE);
    const screen = await render(<ComputerHistorySettingsPanel />);
    const deleteButton = page.getByRole("button", { name: "Delete Editor event" });
    await deleteButton.click();
    const confirming = page.getByRole("button", { name: "Confirm delete Editor event" });
    expect(confirming.element().className).toContain("bg-destructive");
    expect(confirming.element().getAttribute("style")).toContain(
      "0.16s cubic-bezier(0.2, 0.8, 0.2, 1)",
    );
    await userEvent.keyboard("{Escape}");
    await expect.element(page.getByRole("button", { name: "Delete Editor event" })).toBeVisible();
    await page.getByRole("button", { name: "Delete Editor event" }).click();
    document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    await expect.element(page.getByRole("button", { name: "Delete Editor event" })).toBeVisible();
    await screen.unmount();
  });

  it("debounces hover departure for 120ms and cancels it on re-entry", async () => {
    configureApi(PAUSED_STATE);
    const timeoutSpy = vi.spyOn(window, "setTimeout");
    const clearTimeoutSpy = vi.spyOn(window, "clearTimeout");
    const screen = await render(<ComputerHistorySettingsPanel />);
    const chip = page.getByRole("button", { name: "Open Editor menu" });
    await userEvent.hover(chip.element());
    await userEvent.unhover(chip.element());
    const departure = timeoutSpy.mock.calls.find(([, delay]) => delay === 120);
    expect(departure?.[0]).toBeTypeOf("function");
    await userEvent.hover(chip.element());
    expect(clearTimeoutSpy).toHaveBeenCalled();
    (departure?.[0] as (() => void) | undefined)?.();
    await screen.unmount();
    timeoutSpy.mockRestore();
    clearTimeoutSpy.mockRestore();
  });

  it("disables destructive and save actions while their mutations are deferred", async () => {
    configureApi(ON_STATE);
    let resolveClear!: (result: { deletedCount: number; summaryIndexRefresh: "pending" }) => void;
    harness.api.computerHistory.clearHistory.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveClear = resolve;
        }),
    );
    const clearScreen = await render(<ComputerHistorySettingsPanel />);
    await page.getByRole("button", { name: "Clear history" }).click();
    await page.getByRole("menuitem", { name: "Clear all" }).click();
    const clearDialog = page.getByRole("dialog", { name: "Clear history" });
    await clearDialog.getByRole("button", { name: "Clear" }).click();
    await vi.waitFor(() => expect(harness.api.computerHistory.clearHistory).toHaveBeenCalledOnce());
    const pendingClear = clearDialog.getByRole("button", { name: "Clear" });
    expect(pendingClear.element().hasAttribute("disabled")).toBe(true);
    expect(pendingClear.element().getAttribute("aria-busy")).toBe("true");
    resolveClear({ deletedCount: 1, summaryIndexRefresh: "pending" });
    await clearScreen.unmount();

    configureApi(ON_STATE);
    let resolveUpdate!: (state: typeof ON_STATE) => void;
    harness.api.computerHistory.updateSettings.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveUpdate = resolve;
        }),
    );
    const saveScreen = await render(<ComputerHistorySettingsPanel />);
    await page.getByRole("button", { name: "Choose" }).click();
    const done = page.getByRole("button", { name: "Done" });
    await done.click();
    await vi.waitFor(() =>
      expect(harness.api.computerHistory.updateSettings).toHaveBeenCalledOnce(),
    );
    expect(done.element().hasAttribute("disabled")).toBe(true);
    expect(done.element().getAttribute("aria-busy")).toBe("true");
    expect(done.element().querySelector('[data-slot="central-icon"]')?.className).toContain(
      "animate-spin",
    );
    resolveUpdate(ON_STATE);
    await saveScreen.unmount();
  });

  it("matches failed, waiting, and starting activation controls", async () => {
    const intervalSpy = vi.spyOn(window, "setInterval");
    const failedState = makeState({
      enabled: true,
      recorderState: "stopped",
      activationState: "failed",
    });
    configureApi(failedState);
    const failedScreen = await render(<ComputerHistorySettingsPanel />);
    await expect.element(page.getByRole("button", { name: "Try again" })).toBeVisible();
    await failedScreen.unmount();

    const waitingState = makeState({
      enabled: true,
      recorderState: "stopped",
      activationState: "waiting_for_permissions",
    });
    configureApi(waitingState);
    const waitingScreen = await render(<ComputerHistorySettingsPanel />);
    await expect.element(page.getByRole("button", { name: "Finish setup" })).toBeVisible();
    await waitingScreen.unmount();

    const startingState = makeState({
      enabled: true,
      recorderState: "stopped",
      activationState: "starting",
    });
    configureApi(startingState);
    const startingScreen = await render(<ComputerHistorySettingsPanel />);
    const resume = page.getByTestId("computer-history-resume-loading");
    await expect.element(resume).toBeVisible();
    expect(resume.element().getAttribute("aria-busy")).toBe("true");
    expect(resume.element().querySelector('[data-slot="central-icon"]')?.className).toContain(
      "animate-spin",
    );
    expect(intervalSpy.mock.calls.some(([, delay]) => delay === 1_000)).toBe(true);
    await startingScreen.unmount();
    intervalSpy.mockRestore();
  });

  it("has no serious or critical axe violations on the history surface", async () => {
    const restoreTheme = applyCodexDarkElectronTheme();
    configureApi(ON_STATE);
    try {
      const screen = await render(<ComputerHistorySettingsPanel />);
      await expect.element(page.getByTestId("computer-history-timeline")).toBeVisible();
      const result = await axe.run(
        document.querySelector('[data-testid="computer-history-timeline"]') ?? document.body,
      );
      const blocking = result.violations.filter(
        (violation) => violation.impact === "serious" || violation.impact === "critical",
      );
      expect(blocking).toEqual([]);
      await page.getByRole("button", { name: "Choose" }).click();
      const permissionDialog = page.getByRole("dialog", {
        name: "Computer history permissions",
      });
      await expect.element(permissionDialog).toBeVisible();
      // Follow the current theme's link token; the accessibility assertion below
      // still verifies its actual contrast against this dialog's background.
      const linkTokenProbe = document.createElement("span");
      linkTokenProbe.style.color = "var(--color-token-text-link-foreground)";
      permissionDialog.element().append(linkTokenProbe);
      const expectedLinkColor = getComputedStyle(linkTokenProbe).color;
      linkTokenProbe.remove();
      expect(
        getComputedStyle(page.getByTestId("computer-history-permissions-learn-more").element())
          .color,
      ).toBe(expectedLinkColor);
      const permissionAxe = await axe.run(permissionDialog.element());
      const permissionBlocking = permissionAxe.violations.filter(
        (violation) => violation.impact === "serious" || violation.impact === "critical",
      );
      expect(permissionBlocking).toEqual([]);
      await screen.unmount();
    } finally {
      restoreTheme();
    }
  });
});
