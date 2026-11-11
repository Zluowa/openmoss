// FILE: PluginAccessibility.browser.tsx
// Purpose: Measures the plugin library's WCAG 2.2 AA contract in real Playwright Chromium.
// Layer: Browser accessibility tests

import "../index.css";
import "./PluginLibrary.css";

import type { ProviderPluginDescriptor, ProviderPluginDetail } from "@moss/contracts";
import axe from "axe-core";
import { page, userEvent } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { useState, type ComponentProps, type ReactNode } from "react";

import {
  REQUIRED_MOSS_PLUGIN_ACCESSIBILITY_COMPONENTS,
  REQUIRED_MOSS_PLUGIN_ACCESSIBILITY_SCENARIOS,
  REQUIRED_MOSS_PLUGIN_ANNOUNCEMENTS,
  REQUIRED_MOSS_PLUGIN_KEYBOARD_CONTROLS,
  REQUIRED_MOSS_PLUGIN_SEMANTICS,
  REQUIRED_MOSS_PLUGIN_ZOOM_ACTIONS,
  validateMossPluginAccessibilityEvidence,
  type MossPluginAccessibilityEvidenceReport,
  type MossPluginAccessibilityIdentity,
  type MossPluginAccessibilityScenarioId,
  type MossPluginAccessibilityStyleSnapshot,
} from "~/test/pluginAccessibilityContract";

const localizationTestState = vi.hoisted(() => ({ locale: "en" as const }));

vi.mock("../localization", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../localization")>();
  return {
    ...actual,
    useTranslation: () => ({
      locale: localizationTestState.locale,
      t: (key: Parameters<typeof actual.translateMoss>[1]) =>
        actual.translateMoss(localizationTestState.locale, key),
      format: (
        key: Parameters<typeof actual.formatMossTranslation>[1],
        values: Parameters<typeof actual.formatMossTranslation>[2],
      ) => actual.formatMossTranslation(localizationTestState.locale, key, values),
    }),
  };
});

import { PluginsGrid } from "./PluginLibrary";
import { PluginManagementPanel, type ManagedPlugin } from "./PluginManagementPanel";
import { PluginLibraryHeader, PluginLibrarySearchInput } from "./PluginLibraryPrimitives";
import { PluginResourceDetailPage, type ResourceDetail } from "./PluginResourceDetailDialog";
import { PluginRequiredAppsDialog, type PluginRequiredApp } from "./PluginRequiredAppsDialog";
import { mountPluginLibrary, PluginLibraryNativeFixture } from "~/test/pluginLibraryBrowserHarness";

type AxeScenario = MossPluginAccessibilityEvidenceReport["axe"]["scenarios"][number];
type KeyboardJourney = MossPluginAccessibilityEvidenceReport["keyboard"]["journeys"][number];
type FocusAppearance = MossPluginAccessibilityEvidenceReport["keyboard"]["focusAppearance"][number];
type SemanticMeasurement = MossPluginAccessibilityEvidenceReport["semantics"]["controls"][number];
type Announcement = MossPluginAccessibilityEvidenceReport["announcements"][number];
type ZoomMeasurement = MossPluginAccessibilityEvidenceReport["zoom"][number];
type TargetMeasurement = MossPluginAccessibilityEvidenceReport["targetSize"][number];
type DialogMeasurement = MossPluginAccessibilityEvidenceReport["dialog"];

// The contract validates a whole report, including identity fields shaped like a commit
// and two artifact digests; this test fills them with fixed placeholders.
const REPORT_PROGRAM = "moss-plugin-library";
const REPORT_COMMIT = "0".repeat(40);
const REPORT_ARTIFACT_SHA256 = "1".repeat(64);
const REPORT_CAPTURE_SHA256 = "2".repeat(64);
const SOURCE_VIEWPORT_WIDTH = 1280;
const CSS_ZOOM_VIEWPORT_WIDTH = 640;
const VIEWPORT_HEIGHT = 900;
const BLOCKING_IMPACTS = new Set(["serious", "critical"]);
const AXE_WCAG_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22a", "wcag22aa"];

const GITHUB_PLUGIN = {
  id: "github@openai-curated",
  remotePluginId: null,
  name: "github",
  version: "0.1.8",
  localVersion: null,
  shareContext: null,
  availability: "AVAILABLE",
  keywords: ["development"],
  source: { type: "remote" },
  installed: false,
  enabled: false,
  installPolicy: "AVAILABLE",
  installPolicySource: null,
  authPolicy: "ON_USE",
  interface: {
    displayName: "GitHub",
    shortDescription: "Inspect repositories, pull requests, and Actions",
    longDescription: null,
    developerName: "OpenAI",
    category: "Developer Tools",
    capabilities: ["Interactive", "Write"],
    websiteUrl: "https://github.com",
    privacyPolicyUrl: null,
    termsOfServiceUrl: null,
    defaultPrompt: ["Inspect PRs and prepare a review"],
    brandColor: "#24292f",
    composerIcon: null,
    composerIconUrl: null,
    logo: null,
    logoDark: null,
    logoUrl:
      "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='60' height='60'%3E%3Crect width='60' height='60' fill='%2324292f'/%3E%3C/svg%3E",
    logoUrlDark: null,
    screenshots: [],
    screenshotUrls: [],
  },
} satisfies ProviderPluginDescriptor;

const GITHUB_RESOURCE = {
  kind: "plugin",
  plugin: GITHUB_PLUGIN,
  marketplaceName: "openai-curated",
  marketplacePath: null,
  remoteMarketplaceName: "openai-curated",
} satisfies ResourceDetail;

const GITHUB_DETAIL = {
  marketplaceName: "openai-curated",
  marketplacePath: null,
  summary: GITHUB_PLUGIN,
  shareUrl: null,
  description:
    "Use GitHub to inspect repositories, review pull requests, and prepare changes for review.",
  apps: [
    {
      id: "github",
      name: "GitHub",
      description: "Access repositories, issues, and pull requests.",
      installUrl: "https://example.test/connect/github",
      category: "Developer Tools",
    },
  ],
  skills: [],
  hooks: [],
  appTemplates: [],
  mcpServers: [],
} satisfies ProviderPluginDetail;

const LIFECYCLE_PLUGIN = {
  plugin: {
    ...GITHUB_PLUGIN,
    id: "moss-plugin-lifecycle-fixture@moss-parity-fixture",
    name: "moss-plugin-lifecycle-fixture",
    version: "1.0.0",
    localVersion: "1.0.0",
    source: { type: "local", path: "/fixture-marketplace" },
    installed: true,
    enabled: true,
    interface: {
      ...GITHUB_PLUGIN.interface,
      displayName: "Moss lifecycle fixture",
      shortDescription: "Packaged plugin lifecycle smoke fixture",
      defaultPrompt: null,
    },
  },
  marketplaceName: "Moss parity fixture",
  marketplacePath: "/fixture-marketplace/.agents/plugins/marketplace.json",
  remoteMarketplaceName: null,
} satisfies ManagedPlugin;

const REQUIRED_APPS = [
  {
    id: "connector/github",
    name: "GitHub",
    description: "Work with repositories",
    installUrl: "https://example.test/connect/github",
    isAccessible: false,
    logoUrl: null,
    logoUrlDark: null,
    status: "pending",
  },
] satisfies readonly PluginRequiredApp[];

function githubSections(): ComponentProps<typeof PluginsGrid>["sections"] {
  return [
    {
      id: "openai-curated",
      kind: "featured",
      title: "Featured",
      entries: [
        {
          plugin: GITHUB_PLUGIN,
          marketplaceName: "openai-curated",
          marketplacePath: null,
          remoteMarketplaceName: "openai-curated",
          bucket: "moss",
          provenance: "local-or-vertical",
          isFeatured: true,
          createdByYou: false,
          sharedWithYou: false,
        },
      ],
    },
  ];
}

function gridProps(
  overrides: Partial<ComponentProps<typeof PluginsGrid>> = {},
): ComponentProps<typeof PluginsGrid> {
  return {
    canListPlugins: true,
    providerLabel: "Codex",
    isLoading: false,
    error: null,
    queryItemCount: 1,
    retrying: false,
    onRetry: vi.fn(),
    sections: githubSections(),
    hasAny: true,
    activeSearchResultId: null,
    onOpen: vi.fn(),
    onEnable: vi.fn(),
    onInstall: vi.fn(),
    installingPluginKeys: new Set<string>(),
    menuItemsFor: () => [],
    ...overrides,
  };
}

function BrowseSurface() {
  const [query, setQuery] = useState("");
  return (
    <div className="flex min-w-0 flex-col gap-5 p-4" data-a11y-surface="browse">
      <PluginLibraryHeader
        mode="browse"
        selectedTab="plugins"
        onTabChange={vi.fn()}
        onManage={vi.fn()}
        onRefresh={vi.fn()}
        onCreatePlugin={vi.fn()}
        onAddMarketplace={vi.fn()}
      />
      <PluginLibrarySearchInput
        value={query}
        placeholder="Search plugins"
        resultIds={["plugin-result-openai-curated"]}
        onChange={setQuery}
        onActivateResult={vi.fn()}
      />
      <div id="plugins-page-results">
        <PluginsGrid {...gridProps()} />
      </div>
    </div>
  );
}

function InstalledSurface() {
  return (
    <div className="min-w-0" data-a11y-surface="installed">
      <PluginManagementPanel
        plugins={[LIFECYCLE_PLUGIN]}
        apps={[]}
        appsLoading={false}
        appsError={null}
        marketplaces={[]}
        marketplacesLoading={false}
        marketplacesError={null}
        mcpServers={[]}
        skills={[]}
        disabledSkillNames={new Set<string>()}
        onTogglePlugin={vi.fn()}
        onToggleMcp={vi.fn()}
        onToggleSkill={vi.fn()}
        onOpenPlugin={vi.fn()}
      />
    </div>
  );
}

function DetailSurface({ loading = false }: { readonly loading?: boolean }) {
  return (
    <div className="h-[860px] min-w-0" data-a11y-surface="details">
      <PluginResourceDetailPage
        detail={GITHUB_RESOURCE}
        onBack={vi.fn()}
        onTryInChat={vi.fn()}
        onInstall={vi.fn()}
        pluginDetail={loading ? undefined : GITHUB_DETAIL}
        pluginDetailLoading={loading}
      />
    </div>
  );
}

function GridStateSurface({ state }: { readonly state: "error" | "empty" }) {
  return (
    <div className="min-w-0 p-4" data-a11y-surface={state}>
      <PluginsGrid
        {...gridProps({
          error: state === "error" ? new Error("Plugin directory unavailable") : null,
          queryItemCount: 0,
          sections: [],
          hasAny: false,
        })}
      />
    </div>
  );
}

function InstallDialogHarness() {
  const [open, setOpen] = useState(false);
  return (
    <div className="min-w-0 p-4" data-a11y-surface="install-auth-dialog-background">
      <button type="button" aria-label="Install GitHub" onClick={() => setOpen(true)}>
        Install GitHub
      </button>
      <button type="button">Background action</button>
      <PluginRequiredAppsDialog
        open={open}
        pluginName="GitHub"
        pluginLogoUrl={null}
        apps={REQUIRED_APPS}
        onOpenChange={setOpen}
        onConnect={vi.fn()}
        onViewDetails={vi.fn()}
        onTryNow={vi.fn()}
      />
    </div>
  );
}

function normalizeText(value: string | null | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

function fallbackAccessibleName(element: HTMLElement): string {
  const labelledBy = element.getAttribute("aria-labelledby");
  if (labelledBy) {
    const text = labelledBy
      .split(/\s+/)
      .map((id) => document.getElementById(id)?.textContent ?? "")
      .join(" ");
    if (normalizeText(text)) return normalizeText(text);
  }
  const ariaLabel = element.getAttribute("aria-label");
  if (ariaLabel) return normalizeText(ariaLabel);
  if (element instanceof HTMLInputElement) {
    const labels = [...(element.labels ?? [])].map((label) => label.textContent ?? "").join(" ");
    if (normalizeText(labels)) return normalizeText(labels);
  }
  return normalizeText(element.innerText || element.textContent);
}

function accessibleName(element: HTMLElement): string {
  try {
    return normalizeText(axe.commons.text.accessibleText(element));
  } catch {
    return fallbackAccessibleName(element);
  }
}

function semanticRole(element: HTMLElement): string {
  const explicit = element.getAttribute("role")?.trim().split(/\s+/)[0];
  if (explicit) return explicit;
  switch (element.tagName) {
    case "BUTTON":
      return "button";
    case "A":
      return element.hasAttribute("href") ? "link" : "generic";
    case "INPUT": {
      const input = element as HTMLInputElement;
      if (input.type === "checkbox") return "checkbox";
      if (input.type === "radio") return "radio";
      if (input.type === "range") return "slider";
      return "textbox";
    }
    case "TEXTAREA":
      return "textbox";
    case "SELECT":
      return "combobox";
    case "H1":
    case "H2":
    case "H3":
    case "H4":
    case "H5":
    case "H6":
      return "heading";
    default:
      return "generic";
  }
}

function identityOf(element: HTMLElement): MossPluginAccessibilityIdentity {
  return { role: semanticRole(element), name: accessibleName(element) };
}

function sameIdentity(
  left: MossPluginAccessibilityIdentity,
  right: MossPluginAccessibilityIdentity,
): boolean {
  return left.role === right.role && left.name === right.name;
}

function styleSnapshot(element: HTMLElement): MossPluginAccessibilityStyleSnapshot {
  const style = getComputedStyle(element);
  return {
    outlineStyle: style.outlineStyle,
    outlineWidth: style.outlineWidth,
    outlineColor: style.outlineColor,
    boxShadow: style.boxShadow,
  };
}

function focusIndicatorElement(element: HTMLElement): HTMLElement {
  if (element instanceof HTMLInputElement) {
    const inputGroup = element.closest<HTMLElement>('[data-slot="input-group"]');
    if (inputGroup) return inputGroup;
  }
  return element;
}

function hasFocusIndicator(measurement: FocusAppearance): boolean {
  const outlineWidth = Number.parseFloat(measurement.focused.outlineWidth) || 0;
  const visibleOutline = measurement.focused.outlineStyle !== "none" && outlineWidth >= 1;
  const changedOutline =
    measurement.focused.outlineStyle !== measurement.before.outlineStyle ||
    measurement.focused.outlineWidth !== measurement.before.outlineWidth ||
    measurement.focused.outlineColor !== measurement.before.outlineColor;
  const visibleShadow =
    measurement.focused.boxShadow !== "none" &&
    measurement.focused.boxShadow.trim() !== measurement.before.boxShadow.trim();
  return (visibleOutline && changedOutline) || visibleShadow;
}

function isPotentiallyFocusable(element: HTMLElement): boolean {
  if (element.hasAttribute("disabled") || element.getAttribute("aria-disabled") === "true") {
    return false;
  }
  const tabIndex = element.getAttribute("tabindex");
  if (tabIndex !== null && Number(tabIndex) < 0) return false;
  if (tabIndex !== null) return true;
  if (element instanceof HTMLButtonElement || element instanceof HTMLSelectElement) return true;
  if (element instanceof HTMLTextAreaElement) return true;
  if (element instanceof HTMLInputElement) return element.type !== "hidden";
  if (element instanceof HTMLAnchorElement) return element.hasAttribute("href");
  return element.isContentEditable;
}

function isRendered(element: HTMLElement): boolean {
  const style = getComputedStyle(element);
  const rect = element.getBoundingClientRect();
  return (
    style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0
  );
}

function focusableCandidates(
  root: ParentNode,
  includeHidden = false,
  includeRovingTabs = false,
): HTMLElement[] {
  const candidates = Array.from(
    root.querySelectorAll<HTMLElement>(
      "button, input, select, textarea, a[href], [tabindex], [contenteditable='true']",
    ),
  );
  return candidates.filter(
    (element, index) =>
      candidates.indexOf(element) === index &&
      (isPotentiallyFocusable(element) || (includeRovingTabs && semanticRole(element) === "tab")) &&
      (includeHidden || isRendered(element)),
  );
}

function findIdentityElement(
  root: ParentNode,
  expected: MossPluginAccessibilityIdentity,
): HTMLElement | null {
  const candidates = Array.from(root.querySelectorAll<HTMLElement>("*"));
  if (root instanceof HTMLElement) candidates.unshift(root);
  return (
    candidates.find((element) => {
      const actual = identityOf(element);
      return sameIdentity(actual, expected);
    }) ?? null
  );
}

function targetMeasurement(
  scenario: TargetMeasurement["scenario"],
  element: HTMLElement,
): TargetMeasurement {
  const rect = element.getBoundingClientRect();
  return {
    scenario,
    control: identityOf(element),
    width: rect.width,
    height: rect.height,
  };
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

function addIssue(issues: string[], message: string): void {
  if (!issues.includes(message)) issues.push(message);
}

function appendAxeScenario(
  scenarios: AxeScenario[],
  issues: string[],
  id: MossPluginAccessibilityScenarioId,
  result: axe.AxeResults,
): void {
  const scenario: AxeScenario = {
    id,
    testEngine: { name: "axe-core", version: result.testEngine.version },
    violations: result.violations.map((violation) => ({
      id: violation.id,
      impact: violation.impact ?? null,
      tags: [...violation.tags],
      help: violation.help,
      helpUrl: violation.helpUrl,
      nodes: violation.nodes.map((node) => ({
        impact: node.impact ?? null,
        target: node.target.map((target) =>
          typeof target === "string" ? target : JSON.stringify(target),
        ),
        html: node.html,
        failureSummary: node.failureSummary ?? null,
      })),
    })),
  };
  scenarios.push(scenario);
  const blocking = scenario.violations.filter((violation) =>
    BLOCKING_IMPACTS.has(violation.impact ?? ""),
  );
  if (blocking.length > 0) {
    const failureDetails = blocking.flatMap((violation) =>
      violation.nodes.map(
        (node) =>
          `${violation.id} at ${node.target.join(" > ")}: ${normalizeText(node.html).slice(0, 180)}`,
      ),
    );
    addIssue(issues, `${id}: axe serious/critical violations: ${failureDetails.join("; ")}`);
  }
}

async function runAxe(root: axe.ElementContext): Promise<axe.AxeResults> {
  return axe.run(root, {
    runOnly: { type: "tag", values: AXE_WCAG_TAGS },
    resultTypes: ["violations"],
  });
}

function collectSemantics(
  scenario: MossPluginAccessibilityScenarioId,
  root: ParentNode,
  controls: SemanticMeasurement[],
  issues: string[],
): void {
  const required = REQUIRED_MOSS_PLUGIN_SEMANTICS.filter(
    (candidate) => candidate.scenario === scenario,
  );
  for (const expected of required) {
    const element = findIdentityElement(root, expected);
    if (!element) {
      addIssue(issues, `${scenario}: missing semantic ${expected.role} "${expected.name}".`);
      continue;
    }
    const measured: SemanticMeasurement = {
      scenario,
      ...identityOf(element),
      selected: element.getAttribute("aria-selected"),
      checked: element.getAttribute("aria-checked"),
      expanded: element.getAttribute("aria-expanded"),
      modal: element.getAttribute("aria-modal"),
    };
    controls.push(measured);
    if ("selected" in expected && measured.selected !== expected.selected) {
      addIssue(
        issues,
        `${scenario}: ${expected.name} selected=${String(measured.selected)}, expected ${expected.selected}.`,
      );
    }
  }
}

function collectAnnouncement(
  scenario: Announcement["scenario"],
  role: Announcement["role"],
  root: ParentNode,
  announcements: Announcement[],
  issues: string[],
): void {
  const element = root.querySelector<HTMLElement>(`[role="${role}"]`);
  if (!element) {
    addIssue(issues, `${scenario}: missing ${role} live announcement.`);
    return;
  }
  const announcement: Announcement = {
    scenario,
    role,
    ariaLive: element.getAttribute("aria-live"),
    text: normalizeText(element.textContent),
  };
  announcements.push(announcement);
  if (!announcement.text) addIssue(issues, `${scenario}: ${role} announcement is empty.`);
  if (role === "status" && announcement.ariaLive !== "polite") {
    addIssue(
      issues,
      `${scenario}: status aria-live=${String(announcement.ariaLive)}, expected polite.`,
    );
  }
}

async function collectKeyboardJourney(
  scenario: KeyboardJourney["scenario"],
  root: HTMLElement,
  journeys: KeyboardJourney[],
  focusAppearance: FocusAppearance[],
  targets: TargetMeasurement[],
  issues: string[],
): Promise<void> {
  const before = new Map<HTMLElement, MossPluginAccessibilityStyleSnapshot>();
  for (const element of focusableCandidates(root, true, true)) {
    before.set(element, styleSnapshot(focusIndicatorElement(element)));
  }

  if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  await nextFrame();

  const seen = new Set<HTMLElement>();
  const actual: MossPluginAccessibilityIdentity[] = [];
  const scenarioFocus: FocusAppearance[] = [];
  const scenarioTargets: TargetMeasurement[] = [];
  const recordControl = (element: HTMLElement): boolean => {
    if (seen.has(element)) return true;
    seen.add(element);
    const control = identityOf(element);
    actual.push(control);
    scenarioFocus.push({
      scenario,
      control,
      before: before.get(element) ?? styleSnapshot(focusIndicatorElement(element)),
      focused: styleSnapshot(focusIndicatorElement(element)),
    });
    scenarioTargets.push(targetMeasurement(scenario, element));
    return false;
  };
  const maxTabs = Math.max(before.size * 3 + 4, 32);
  for (let index = 0; index < maxTabs; index += 1) {
    await userEvent.tab();
    await nextFrame();
    const active = document.activeElement;
    if (!(active instanceof HTMLElement) || !root.contains(active)) continue;
    if (recordControl(active)) break;

    // WAI-ARIA tablists expose one Tab stop and use arrow keys to move among
    // tabs. Measure every roving tab through that real interaction instead of
    // treating the intentionally negative tabIndex siblings as unreachable.
    if (semanticRole(active) === "tab") {
      const tablist = active.closest<HTMLElement>('[role="tablist"]');
      const tabs = tablist
        ? Array.from(tablist.querySelectorAll<HTMLElement>('[role="tab"]')).filter((tab) =>
            isRendered(tab),
          )
        : [];
      for (let tabIndex = 1; tabIndex < tabs.length; tabIndex += 1) {
        await userEvent.keyboard("{ArrowRight}");
        await nextFrame();
        const nextTab = document.activeElement;
        if (!(nextTab instanceof HTMLElement) || !root.contains(nextTab)) break;
        recordControl(nextTab);
      }
      if (tabs.length > 1) {
        // Complete the cycle so ordinary Tab continues from the original
        // active tab and the measured panel returns to its initial content.
        await userEvent.keyboard("{ArrowRight}");
        await nextFrame();

        // Switching tabs may remount the active panel. Capture the unfocused
        // baseline for those new control elements now; otherwise their first
        // lookup happens only after focus and makes before/focused identical.
        for (const element of focusableCandidates(root, true, true)) {
          if (!before.has(element) && element !== document.activeElement) {
            before.set(element, styleSnapshot(focusIndicatorElement(element)));
          }
        }
      }
    }
  }

  journeys.push({ scenario, actual });
  focusAppearance.push(...scenarioFocus);
  targets.push(...scenarioTargets);

  for (const required of REQUIRED_MOSS_PLUGIN_KEYBOARD_CONTROLS[scenario]) {
    if (!actual.some((candidate) => sameIdentity(candidate, required))) {
      addIssue(
        issues,
        `${scenario}: keyboard did not reach ${required.role} "${required.name}"; measured ${actual
          .map((candidate) => `${candidate.role} "${candidate.name}"`)
          .join(", ")}.`,
      );
    }
    const focus = scenarioFocus.find((candidate) => sameIdentity(candidate.control, required));
    if (!focus || !hasFocusIndicator(focus)) {
      addIssue(issues, `${scenario}: no measured visible focus for ${required.name}.`);
    }
    const target = scenarioTargets.find((candidate) => sameIdentity(candidate.control, required));
    if (!target || target.width < 24 || target.height < 24) {
      addIssue(
        issues,
        `${scenario}: ${required.name} target is ${target?.width ?? 0}x${target?.height ?? 0}, expected at least 24x24.`,
      );
    }
  }
}

function uniqueNames(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

async function collectZoom(
  scenario: ZoomMeasurement["scenario"],
  surface: HTMLElement,
  zoom: ZoomMeasurement[],
  issues: string[],
): Promise<void> {
  await page.viewport(CSS_ZOOM_VIEWPORT_WIDTH, VIEWPORT_HEIGHT);
  await nextFrame();
  await nextFrame();

  const surfaceRect = surface.getBoundingClientRect();
  // Roving tab siblings remain rendered, operable actions at 200% zoom even
  // though only the selected tab participates in sequential Tab navigation.
  const actionElements = focusableCandidates(surface, false, true);
  const actionNames = uniqueNames(actionElements.map(accessibleName));
  const visibleActionNames: string[] = [];
  const clippedActionNames: string[] = [];
  for (const element of actionElements) {
    const name = accessibleName(element);
    if (!name) continue;
    const rect = element.getBoundingClientRect();
    const horizontallyVisible =
      rect.left >= Math.max(0, surfaceRect.left) - 0.5 &&
      rect.right <= Math.min(window.innerWidth, surfaceRect.right) + 0.5;
    if (horizontallyVisible && isRendered(element)) visibleActionNames.push(name);
    else clippedActionNames.push(name);
  }

  const intentionalScrollRegions = Array.from(surface.querySelectorAll<HTMLElement>("*"))
    .filter((element) => {
      const overflowX = getComputedStyle(element).overflowX;
      return (
        (overflowX === "auto" || overflowX === "scroll") &&
        element.scrollWidth > element.clientWidth
      );
    })
    .map((element) => ({
      name:
        accessibleName(element) ||
        element.dataset.testid ||
        element.getAttribute("data-slot") ||
        element.tagName.toLowerCase(),
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
    }));
  const documentClientWidth = document.documentElement.clientWidth;
  const documentScrollWidth = Math.max(
    document.documentElement.scrollWidth,
    document.body.scrollWidth,
  );
  const measurement: ZoomMeasurement = {
    scenario,
    scalePercent: 200,
    sourceViewportWidth: SOURCE_VIEWPORT_WIDTH,
    cssViewportWidth: window.innerWidth,
    documentClientWidth,
    documentScrollWidth,
    surfaceClientWidth: surface.clientWidth,
    surfaceScrollWidth: surface.scrollWidth,
    actionNames,
    visibleActionNames: uniqueNames(visibleActionNames),
    clippedActionNames: uniqueNames(clippedActionNames),
    intentionalScrollRegions,
  };
  zoom.push(measurement);

  if (measurement.cssViewportWidth !== CSS_ZOOM_VIEWPORT_WIDTH) {
    addIssue(issues, `${scenario}: CSS viewport is ${measurement.cssViewportWidth}, expected 640.`);
  }
  if (documentScrollWidth > documentClientWidth) {
    addIssue(
      issues,
      `${scenario}: page overflows horizontally (${documentScrollWidth} > ${documentClientWidth}).`,
    );
  }
  if (measurement.surfaceScrollWidth > measurement.surfaceClientWidth) {
    addIssue(
      issues,
      `${scenario}: surface overflows horizontally (${measurement.surfaceScrollWidth} > ${measurement.surfaceClientWidth}).`,
    );
  }
  if (measurement.clippedActionNames.length > 0) {
    addIssue(issues, `${scenario}: clipped actions: ${measurement.clippedActionNames.join(", ")}.`);
  }
  for (const required of REQUIRED_MOSS_PLUGIN_ZOOM_ACTIONS[scenario]) {
    if (!measurement.actionNames.includes(required)) {
      addIssue(issues, `${scenario}: 200% zoom did not expose action "${required}".`);
    } else if (!measurement.visibleActionNames.includes(required)) {
      addIssue(issues, `${scenario}: 200% zoom clipped action "${required}".`);
    }
  }
}

function inertAncestorCount(element: HTMLElement): number {
  let count = 0;
  let current: HTMLElement | null = element;
  while (current) {
    if (
      current.hasAttribute("inert") ||
      current.inert ||
      current.getAttribute("aria-hidden") === "true" ||
      current.hasAttribute("data-base-ui-inert")
    ) {
      count += 1;
    }
    current = current.parentElement;
  }
  return count;
}

async function collectDialogMeasurement(input: {
  dialog: HTMLElement;
  trigger: HTMLElement;
  background: HTMLElement;
  focusAppearance: FocusAppearance[];
  targets: TargetMeasurement[];
  issues: string[];
}): Promise<DialogMeasurement> {
  const { dialog, trigger, background, focusAppearance, targets, issues } = input;
  const expectedActions: MossPluginAccessibilityIdentity[] = [
    { role: "button", name: "Connect" },
    { role: "button", name: "View details" },
    { role: "button", name: "Try GitHub now" },
    { role: "button", name: "Close" },
  ];
  const initial = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const initialFocus =
    initial && dialog.contains(initial) ? identityOf(initial) : { role: "", name: "" };
  const candidates = focusableCandidates(dialog, true);
  const before = new Map<HTMLElement, MossPluginAccessibilityStyleSnapshot>();
  const focused = new Map<HTMLElement, MossPluginAccessibilityStyleSnapshot>();
  for (const element of candidates) {
    if (element !== initial) {
      before.set(element, styleSnapshot(focusIndicatorElement(element)));
    }
  }
  if (initial && dialog.contains(initial))
    focused.set(initial, styleSnapshot(focusIndicatorElement(initial)));

  const forwardTabSequence: MossPluginAccessibilityIdentity[] = [];
  const reverseTabSequence: MossPluginAccessibilityIdentity[] = [];
  const backgroundTabStops: MossPluginAccessibilityIdentity[] = [];
  const forwardSeen = new Set<HTMLElement>();
  const recordForward = () => {
    const active = document.activeElement;
    if (!(active instanceof HTMLElement)) return false;
    if (!dialog.contains(active)) {
      if (active !== document.body) backgroundTabStops.push(identityOf(active));
      return false;
    }
    if (forwardSeen.has(active)) {
      focused.set(active, styleSnapshot(focusIndicatorElement(active)));
      return true;
    }
    forwardSeen.add(active);
    forwardTabSequence.push(identityOf(active));
    focused.set(active, styleSnapshot(focusIndicatorElement(active)));
    targets.push(targetMeasurement("install-auth-dialog", active));
    return false;
  };
  recordForward();
  for (let index = 0; index < Math.max(candidates.length * 2 + 2, 10); index += 1) {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    await userEvent.tab();
    await nextFrame();
    if (previous && !before.has(previous) && document.activeElement !== previous) {
      before.set(previous, styleSnapshot(focusIndicatorElement(previous)));
    }
    if (recordForward()) break;
  }

  const reverseSeen = new Set<HTMLElement>();
  const recordReverse = () => {
    const active = document.activeElement;
    if (!(active instanceof HTMLElement)) return false;
    if (!dialog.contains(active)) {
      if (active !== document.body) backgroundTabStops.push(identityOf(active));
      return false;
    }
    if (reverseSeen.has(active)) return true;
    reverseSeen.add(active);
    reverseTabSequence.push(identityOf(active));
    return false;
  };
  recordReverse();
  for (let index = 0; index < Math.max(candidates.length * 2 + 2, 10); index += 1) {
    await userEvent.tab({ shift: true });
    await nextFrame();
    if (recordReverse()) break;
  }

  for (const expected of expectedActions) {
    const element = findIdentityElement(dialog, expected);
    if (!element) {
      addIssue(issues, `install-auth-dialog: missing ${expected.name}.`);
      continue;
    }
    const measurement: FocusAppearance = {
      scenario: "install-auth-dialog",
      control: identityOf(element),
      before: before.get(element) ?? styleSnapshot(focusIndicatorElement(element)),
      focused: focused.get(element) ?? styleSnapshot(focusIndicatorElement(element)),
    };
    focusAppearance.push(measurement);
    if (!hasFocusIndicator(measurement)) {
      addIssue(issues, `install-auth-dialog: no measured visible focus for ${expected.name}.`);
    }
    const target = targetMeasurement("install-auth-dialog", element);
    if (!targets.some((candidate) => sameIdentity(candidate.control, target.control))) {
      targets.push(target);
    }
    if (target.width < 24 || target.height < 24) {
      addIssue(
        issues,
        `install-auth-dialog: ${expected.name} target is ${target.width}x${target.height}.`,
      );
    }
    if (!forwardTabSequence.some((candidate) => sameIdentity(candidate, expected))) {
      addIssue(issues, `install-auth-dialog: forward Tab missed ${expected.name}.`);
    }
    if (!reverseTabSequence.some((candidate) => sameIdentity(candidate, expected))) {
      addIssue(issues, `install-auth-dialog: reverse Tab missed ${expected.name}.`);
    }
  }

  if (!expectedActions.some((candidate) => sameIdentity(candidate, initialFocus))) {
    addIssue(
      issues,
      `install-auth-dialog: initial focus was ${initialFocus.role} "${initialFocus.name}".`,
    );
  }
  if (backgroundTabStops.length > 0) {
    addIssue(
      issues,
      `install-auth-dialog: focus escaped to ${backgroundTabStops.map((item) => item.name).join(", ")}.`,
    );
  }

  const role = semanticRole(dialog);
  const name = accessibleName(dialog);
  const ariaModal = dialog.getAttribute("aria-modal");
  const backgroundInertAncestorCount = inertAncestorCount(background);
  if (role !== "dialog" || name !== "Connect your apps to GitHub" || ariaModal !== "true") {
    addIssue(
      issues,
      `install-auth-dialog: measured role/name/modal was ${role}/${name}/${String(ariaModal)}.`,
    );
  }
  if (backgroundInertAncestorCount < 1) {
    addIssue(issues, "install-auth-dialog: background has no modal-isolated ancestor.");
  }

  await userEvent.keyboard("{Escape}");
  await vi.waitFor(() => {
    if (document.querySelectorAll('[role="dialog"]').length !== 0) {
      throw new Error("Dialog is still open after Escape.");
    }
  });
  const restoredFocus =
    document.activeElement instanceof HTMLElement
      ? identityOf(document.activeElement)
      : { role: "", name: "" };
  if (!sameIdentity(restoredFocus, { role: "button", name: "Install GitHub" })) {
    addIssue(
      issues,
      `install-auth-dialog: Escape restored ${restoredFocus.role} "${restoredFocus.name}".`,
    );
  }

  return {
    trigger: identityOf(trigger),
    role,
    name,
    ariaModal,
    initialFocus,
    forwardTabSequence,
    reverseTabSequence,
    backgroundTabStops,
    backgroundInertAncestorCount,
    afterEscapeDialogCount: document.querySelectorAll('[role="dialog"]').length,
    restoredFocus,
  };
}

async function renderIntoBody(node: ReactNode) {
  const host = document.createElement("div");
  host.style.width = "100%";
  host.style.minWidth = "0";
  document.body.append(host);
  const screen = await render(node, { container: host });
  return {
    host,
    screen,
    async cleanup() {
      await screen.unmount();
      host.remove();
      document.body.innerHTML = "";
    },
  };
}

describe("Moss plugin library accessibility contract", () => {
  afterEach(async () => {
    await page.viewport(SOURCE_VIEWPORT_WIDTH, VIEWPORT_HEIGHT);
    document.body.innerHTML = "";
  });

  it("measures WCAG, keyboard, semantics, dialog, announcements, reflow, and targets", async () => {
    await page.viewport(SOURCE_VIEWPORT_WIDTH, VIEWPORT_HEIGHT);
    const issues: string[] = [];
    const axeScenarios: AxeScenario[] = [];
    const journeys: KeyboardJourney[] = [];
    const focusAppearance: FocusAppearance[] = [];
    const semantics: SemanticMeasurement[] = [];
    const announcements: Announcement[] = [];
    const zoom: ZoomMeasurement[] = [];
    const targets: TargetMeasurement[] = [];

    const browse = await renderIntoBody(<BrowseSurface />);
    const browseSurface = document.querySelector<HTMLElement>('[data-a11y-surface="browse"]')!;
    appendAxeScenario(axeScenarios, issues, "browse", await runAxe(browseSurface));
    collectSemantics("browse", browseSurface, semantics, issues);
    await collectKeyboardJourney(
      "browse",
      browseSurface,
      journeys,
      focusAppearance,
      targets,
      issues,
    );
    await collectZoom("browse", browseSurface, zoom, issues);
    await browse.cleanup();

    await page.viewport(SOURCE_VIEWPORT_WIDTH, VIEWPORT_HEIGHT);
    const installed = await renderIntoBody(<InstalledSurface />);
    const installedSurface = document.querySelector<HTMLElement>(
      '[data-a11y-surface="installed"]',
    )!;
    appendAxeScenario(axeScenarios, issues, "installed", await runAxe(installedSurface));
    collectSemantics("installed", installedSurface, semantics, issues);
    await collectKeyboardJourney(
      "installed",
      installedSurface,
      journeys,
      focusAppearance,
      targets,
      issues,
    );
    await collectZoom("installed", installedSurface, zoom, issues);
    await installed.cleanup();

    await page.viewport(SOURCE_VIEWPORT_WIDTH, VIEWPORT_HEIGHT);
    const details = await renderIntoBody(<DetailSurface />);
    const detailsSurface = document.querySelector<HTMLElement>('[data-a11y-surface="details"]')!;
    appendAxeScenario(axeScenarios, issues, "details", await runAxe(detailsSurface));
    collectSemantics("details", detailsSurface, semantics, issues);
    await collectKeyboardJourney(
      "details",
      detailsSurface,
      journeys,
      focusAppearance,
      targets,
      issues,
    );
    await collectZoom("details", detailsSurface, zoom, issues);
    await details.cleanup();

    await page.viewport(SOURCE_VIEWPORT_WIDTH, VIEWPORT_HEIGHT);
    const loadingDetails = await renderIntoBody(<DetailSurface loading />);
    collectAnnouncement(
      "details",
      "status",
      document.querySelector<HTMLElement>('[data-a11y-surface="details"]')!,
      announcements,
      issues,
    );
    await loadingDetails.cleanup();

    const dialogHarness = await renderIntoBody(<InstallDialogHarness />);
    const trigger = document.querySelector<HTMLElement>('[aria-label="Install GitHub"]')!;
    const background = Array.from(document.querySelectorAll<HTMLElement>("button")).find(
      (element) => normalizeText(element.textContent) === "Background action",
    )!;
    await userEvent.click(trigger);
    await vi.waitFor(() => {
      if (!document.querySelector('[role="dialog"]')) throw new Error("Dialog did not open.");
    });
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
    appendAxeScenario(axeScenarios, issues, "install-auth-dialog", await runAxe(document.body));
    collectSemantics("install-auth-dialog", dialog, semantics, issues);
    collectAnnouncement("install-auth-dialog", "status", dialog, announcements, issues);
    await collectZoom("install-auth-dialog", dialog, zoom, issues);
    await page.viewport(SOURCE_VIEWPORT_WIDTH, VIEWPORT_HEIGHT);
    const dialogMeasurement = await collectDialogMeasurement({
      dialog,
      trigger,
      background,
      focusAppearance,
      targets,
      issues,
    });
    await dialogHarness.cleanup();

    const error = await renderIntoBody(<GridStateSurface state="error" />);
    const errorSurface = document.querySelector<HTMLElement>('[data-a11y-surface="error"]')!;
    appendAxeScenario(axeScenarios, issues, "error", await runAxe(errorSurface));
    collectAnnouncement("error", "alert", errorSurface, announcements, issues);
    await error.cleanup();

    const empty = await renderIntoBody(<GridStateSurface state="empty" />);
    const emptySurface = document.querySelector<HTMLElement>('[data-a11y-surface="empty"]')!;
    appendAxeScenario(axeScenarios, issues, "empty", await runAxe(emptySurface));
    collectAnnouncement("empty", "status", emptySurface, announcements, issues);
    await empty.cleanup();

    const createdAt = new Date().toISOString();
    const report: MossPluginAccessibilityEvidenceReport = {
      schemaVersion: 1,
      program: REPORT_PROGRAM,
      gate: "accessibility",
      status: "pass",
      createdAt,
      commit: REPORT_COMMIT,
      artifactSha256: REPORT_ARTIFACT_SHA256,
      captureSha256: REPORT_CAPTURE_SHA256,
      runner: {
        name: "vitest-browser",
        provider: "playwright",
        browser: "chromium",
        userAgent: navigator.userAgent,
        webdriver: navigator.webdriver,
        locale: "en",
        testFile: "PluginAccessibility.browser.tsx",
        renderedComponents: [...REQUIRED_MOSS_PLUGIN_ACCESSIBILITY_COMPONENTS],
      },
      axe: { scenarios: axeScenarios },
      keyboard: { journeys, focusAppearance },
      dialog: dialogMeasurement,
      semantics: { controls: semantics },
      announcements,
      zoom,
      targetSize: targets,
    };

    if (!/Chrome\/[0-9.]+/.test(report.runner.userAgent)) {
      addIssue(issues, `runner: expected Chromium user agent, got ${report.runner.userAgent}.`);
    }
    if (!report.runner.webdriver) addIssue(issues, "runner: navigator.webdriver is false.");
    if (!navigator.language.toLowerCase().startsWith("en")) {
      addIssue(issues, `runner: browser locale is ${navigator.language}, expected en.`);
    }
    if (
      axeScenarios.length !== REQUIRED_MOSS_PLUGIN_ACCESSIBILITY_SCENARIOS.length ||
      REQUIRED_MOSS_PLUGIN_ACCESSIBILITY_SCENARIOS.some(
        (scenario) => !axeScenarios.some((candidate) => candidate.id === scenario),
      )
    ) {
      addIssue(issues, "runner: axe did not measure every required scenario exactly once.");
    }
    for (const required of REQUIRED_MOSS_PLUGIN_ANNOUNCEMENTS) {
      if (
        !announcements.some(
          (candidate) =>
            candidate.scenario === required.scenario && candidate.role === required.role,
        )
      ) {
        addIssue(issues, `${required.scenario}: required ${required.role} was not measured.`);
      }
    }

    const validation = validateMossPluginAccessibilityEvidence({
      document: report,
      program: report.program,
      commit: report.commit,
      artifactSha256: report.artifactSha256,
      captureSha256: report.captureSha256,
      evaluatedAt: createdAt,
    });
    for (const issue of validation.issues) addIssue(issues, `schema: ${issue}`);

    expect(issues, issues.join("\n")).toEqual([]);
  });
});

describe("PluginLibrary complete-page accessibility", () => {
  it("mounts the real route, queries, and controls for axe and keyboard verification", async () => {
    const mounted = await mountPluginLibrary({
      fixture: new PluginLibraryNativeFixture("populated"),
    });

    try {
      await expect.poll(() => mounted.host.textContent, { timeout: 3_000 }).toContain("GitHub");

      const result = await runAxe(mounted.host);
      const blocking = result.violations
        .filter((violation) => BLOCKING_IMPACTS.has(violation.impact ?? ""))
        .flatMap((violation) =>
          violation.nodes.map(
            (node) =>
              `${violation.id} at ${node.target.join(" > ")}: ${normalizeText(node.failureSummary)}`,
          ),
        );
      expect(blocking, blocking.join("\n")).toEqual([]);

      const heading = mounted.host.querySelector("h1");
      const search = mounted.host.querySelector<HTMLInputElement>("#plugins-page-search");
      expect(normalizeText(heading?.textContent)).toBe("Plugins");
      expect(search?.getAttribute("role")).toBe("combobox");
      expect(search?.getAttribute("aria-controls")).toBe("plugins-page-results");

      search?.focus();
      expect(document.activeElement).toBe(search);
      await userEvent.tab();
      expect(mounted.host.contains(document.activeElement)).toBe(true);
    } finally {
      await mounted.cleanup();
    }
  });
});
