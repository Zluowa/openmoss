// FILE: pluginAccessibilityContract.ts
// Purpose: The WCAG 2.2 AA contract PluginAccessibility.browser.tsx measures the plugin
//          surfaces against: required scenarios, controls, announcements and the report check.
// Layer: Web browser-test support

export const MOSS_PLUGIN_ACCESSIBILITY_SCHEMA_VERSION = 1 as const;
export const MOSS_PLUGIN_ACCESSIBILITY_MAX_AGE_MS = 24 * 60 * 60 * 1_000;

export const REQUIRED_MOSS_PLUGIN_ACCESSIBILITY_SCENARIOS = [
  "browse",
  "installed",
  "details",
  "install-auth-dialog",
  "error",
  "empty",
] as const;

export type MossPluginAccessibilityScenarioId =
  (typeof REQUIRED_MOSS_PLUGIN_ACCESSIBILITY_SCENARIOS)[number];

export interface MossPluginAccessibilityIdentity {
  role: string;
  name: string;
}

export interface MossPluginAccessibilityStyleSnapshot {
  outlineStyle: string;
  outlineWidth: string;
  outlineColor: string;
  boxShadow: string;
}

export interface MossPluginAccessibilityEvidenceReport {
  schemaVersion: 1;
  program: string;
  gate: "accessibility";
  status: "pass";
  createdAt: string;
  commit: string;
  artifactSha256: string;
  captureSha256: string;
  runner: {
    name: "vitest-browser";
    provider: "playwright";
    browser: "chromium";
    userAgent: string;
    webdriver: boolean;
    locale: "en";
    testFile: "PluginAccessibility.browser.tsx";
    renderedComponents: string[];
  };
  axe: {
    scenarios: Array<{
      id: MossPluginAccessibilityScenarioId;
      testEngine: { name: "axe-core"; version: string };
      violations: Array<{
        id: string;
        impact: "minor" | "moderate" | "serious" | "critical" | null;
        tags: string[];
        help: string;
        helpUrl: string;
        nodes: Array<{
          impact: "minor" | "moderate" | "serious" | "critical" | null;
          target: string[];
          html: string;
          failureSummary: string | null;
        }>;
      }>;
    }>;
  };
  keyboard: {
    journeys: Array<{
      scenario: "browse" | "installed" | "details";
      actual: MossPluginAccessibilityIdentity[];
    }>;
    focusAppearance: Array<{
      scenario: "browse" | "installed" | "details" | "install-auth-dialog";
      control: MossPluginAccessibilityIdentity;
      before: MossPluginAccessibilityStyleSnapshot;
      focused: MossPluginAccessibilityStyleSnapshot;
    }>;
  };
  dialog: {
    trigger: MossPluginAccessibilityIdentity;
    role: string;
    name: string;
    ariaModal: string | null;
    initialFocus: MossPluginAccessibilityIdentity;
    forwardTabSequence: MossPluginAccessibilityIdentity[];
    reverseTabSequence: MossPluginAccessibilityIdentity[];
    backgroundTabStops: MossPluginAccessibilityIdentity[];
    backgroundInertAncestorCount: number;
    afterEscapeDialogCount: number;
    restoredFocus: MossPluginAccessibilityIdentity;
  };
  semantics: {
    controls: Array<
      MossPluginAccessibilityIdentity & {
        scenario: MossPluginAccessibilityScenarioId;
        selected: string | null;
        checked: string | null;
        expanded: string | null;
        modal: string | null;
      }
    >;
  };
  announcements: Array<{
    scenario: "details" | "install-auth-dialog" | "error" | "empty";
    role: string;
    ariaLive: string | null;
    text: string;
  }>;
  zoom: Array<{
    scenario: "browse" | "installed" | "details" | "install-auth-dialog";
    scalePercent: number;
    sourceViewportWidth: number;
    cssViewportWidth: number;
    documentClientWidth: number;
    documentScrollWidth: number;
    surfaceClientWidth: number;
    surfaceScrollWidth: number;
    actionNames: string[];
    visibleActionNames: string[];
    clippedActionNames: string[];
    intentionalScrollRegions: Array<{
      name: string;
      clientWidth: number;
      scrollWidth: number;
    }>;
  }>;
  targetSize: Array<{
    scenario: "browse" | "installed" | "details" | "install-auth-dialog";
    control: MossPluginAccessibilityIdentity;
    width: number;
    height: number;
  }>;
}

export interface MossPluginAccessibilityValidationInput {
  document: unknown;
  program: string;
  commit: string;
  artifactSha256: string;
  captureSha256: string;
  evaluatedAt: string;
}

export interface MossPluginAccessibilityValidationResult {
  issues: string[];
  serious: number;
  critical: number;
  scenariosPassed: number;
  scenariosTotal: number;
}

const SHA256_PATTERN = /^[a-f0-9]{64}$/i;
const FULL_COMMIT_PATTERN = /^[a-f0-9]{40}$/i;
const SEMVER_PATTERN = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
const AXE_IMPACTS = new Set<unknown>(["minor", "moderate", "serious", "critical", null]);
const AXE_IMPACT_RANK = new Map<unknown, number>([
  [null, 0],
  ["minor", 1],
  ["moderate", 2],
  ["serious", 3],
  ["critical", 4],
]);
const PRIVATE_DATA_PATTERN =
  /(?:\/Users\/[^/\s"']+\/|[A-Za-z]:\\Users\\[^\\\s"']+\\|\bBearer\s+[A-Za-z0-9._~-]+|\b(?:access|refresh)[_-]?token\b|\bapi[_-]?key\b|[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})/i;

export const REQUIRED_MOSS_PLUGIN_ACCESSIBILITY_COMPONENTS = [
  "PluginLibraryHeader",
  "PluginLibrarySearchInput",
  "PluginsGrid",
  "PluginManagementPanel",
  "PluginResourceDetailPage",
  "PluginRequiredAppsDialog",
] as const;

export const REQUIRED_MOSS_PLUGIN_KEYBOARD_CONTROLS = {
  browse: [
    { role: "tab", name: "Plugins" },
    { role: "tab", name: "Skills" },
    { role: "button", name: "Refresh" },
    { role: "button", name: "Manage" },
    { role: "button", name: "Create" },
    { role: "combobox", name: "Search plugins" },
    { role: "button", name: "GitHub" },
    { role: "button", name: "Install" },
  ],
  installed: [
    { role: "tab", name: "Plugins 1" },
    { role: "tab", name: "Apps 0" },
    { role: "tab", name: "MCPs 0" },
    { role: "textbox", name: "Search plugins" },
    { role: "button", name: "Moss lifecycle fixture" },
    { role: "button", name: "More actions" },
    { role: "switch", name: "Toggle Moss lifecycle fixture" },
  ],
  details: [
    { role: "button", name: "Plugins" },
    { role: "button", name: "Install plugin" },
    { role: "button", name: "GitHub Inspect PRs and prepare a review" },
  ],
} as const;

export const REQUIRED_MOSS_PLUGIN_SEMANTICS = [
  { scenario: "browse", role: "tab", name: "Plugins", selected: "true" },
  { scenario: "browse", role: "tab", name: "Skills", selected: "false" },
  { scenario: "browse", role: "combobox", name: "Search plugins" },
  { scenario: "installed", role: "tab", name: "Plugins 1", selected: "true" },
  { scenario: "installed", role: "tab", name: "Apps 0", selected: "false" },
  { scenario: "installed", role: "tab", name: "MCPs 0", selected: "false" },
  { scenario: "installed", role: "switch", name: "Toggle Moss lifecycle fixture" },
  { scenario: "details", role: "heading", name: "GitHub" },
  { scenario: "details", role: "button", name: "Install plugin" },
  {
    scenario: "install-auth-dialog",
    role: "dialog",
    name: "Connect your apps to GitHub",
  },
] as const;

export const REQUIRED_MOSS_PLUGIN_ANNOUNCEMENTS = [
  { scenario: "details", role: "status" },
  { scenario: "install-auth-dialog", role: "status" },
  { scenario: "error", role: "alert" },
  { scenario: "empty", role: "status" },
] as const;

export const REQUIRED_MOSS_PLUGIN_ZOOM_ACTIONS = {
  browse: ["Plugins", "Skills", "Refresh", "Manage", "Create", "Search plugins", "GitHub"],
  installed: ["Plugins 1", "Apps 0", "MCPs 0", "Search plugins", "Moss lifecycle fixture"],
  details: ["Plugins", "Install plugin"],
  "install-auth-dialog": ["Connect", "View details", "Try GitHub now", "Close"],
} as const;

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function string(value: unknown): value is string {
  return typeof value === "string";
}

function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function identity(value: unknown): MossPluginAccessibilityIdentity | null {
  const candidate = record(value);
  return candidate && string(candidate.role) && string(candidate.name)
    ? { role: candidate.role, name: candidate.name }
    : null;
}

function sameIdentity(
  left: MossPluginAccessibilityIdentity,
  right: MossPluginAccessibilityIdentity,
): boolean {
  return left.role === right.role && left.name === right.name;
}

function containsIdentity(
  values: readonly MossPluginAccessibilityIdentity[],
  required: MossPluginAccessibilityIdentity,
): boolean {
  return values.some((value) => sameIdentity(value, required));
}

function styleSnapshot(value: unknown): MossPluginAccessibilityStyleSnapshot | null {
  const candidate = record(value);
  if (
    !candidate ||
    !string(candidate.outlineStyle) ||
    !string(candidate.outlineWidth) ||
    !string(candidate.outlineColor) ||
    !string(candidate.boxShadow)
  ) {
    return null;
  }
  return {
    outlineStyle: candidate.outlineStyle,
    outlineWidth: candidate.outlineWidth,
    outlineColor: candidate.outlineColor,
    boxShadow: candidate.boxShadow,
  };
}

function numericCssPixels(value: string): number {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function hasMeasuredFocusIndicator(
  before: MossPluginAccessibilityStyleSnapshot,
  focused: MossPluginAccessibilityStyleSnapshot,
): boolean {
  const outlineVisible =
    focused.outlineStyle !== "none" && numericCssPixels(focused.outlineWidth) >= 1;
  const outlineChanged =
    focused.outlineStyle !== before.outlineStyle ||
    focused.outlineWidth !== before.outlineWidth ||
    focused.outlineColor !== before.outlineColor;
  const shadowVisible =
    focused.boxShadow !== "none" && focused.boxShadow.trim() !== before.boxShadow.trim();
  return (outlineVisible && outlineChanged) || shadowVisible;
}

function exactScenarioSet(values: unknown[]): boolean {
  const ids = values.map((value) => record(value)?.id);
  return (
    ids.length === REQUIRED_MOSS_PLUGIN_ACCESSIBILITY_SCENARIOS.length &&
    new Set(ids).size === ids.length &&
    REQUIRED_MOSS_PLUGIN_ACCESSIBILITY_SCENARIOS.every((id) => ids.includes(id))
  );
}

function addIssue(issues: string[], message: string): void {
  if (!issues.includes(message)) issues.push(message);
}

function validatesNoPrivateData(document: unknown): boolean {
  try {
    return !PRIVATE_DATA_PATTERN.test(JSON.stringify(document));
  } catch {
    return false;
  }
}

export function validateMossPluginAccessibilityEvidence(
  input: MossPluginAccessibilityValidationInput,
): MossPluginAccessibilityValidationResult {
  const issues: string[] = [];
  let serious = 0;
  let critical = 0;
  let scenariosPassed = 0;
  const root = record(input.document);
  if (!root) {
    return {
      issues: ["Accessibility evidence must be a JSON object."],
      serious,
      critical,
      scenariosPassed,
      scenariosTotal: REQUIRED_MOSS_PLUGIN_ACCESSIBILITY_SCENARIOS.length,
    };
  }

  if (
    root.schemaVersion !== MOSS_PLUGIN_ACCESSIBILITY_SCHEMA_VERSION ||
    root.program !== input.program ||
    root.gate !== "accessibility" ||
    root.status !== "pass"
  ) {
    addIssue(issues, "Accessibility evidence identity or schema is invalid.");
  }
  if (
    root.commit !== input.commit ||
    !FULL_COMMIT_PATTERN.test(String(root.commit ?? "")) ||
    root.artifactSha256 !== input.artifactSha256 ||
    root.captureSha256 !== input.captureSha256 ||
    !SHA256_PATTERN.test(String(root.artifactSha256 ?? "")) ||
    !SHA256_PATTERN.test(String(root.captureSha256 ?? ""))
  ) {
    addIssue(issues, "Accessibility evidence is not bound to the evaluated commit and artifacts.");
  }

  const createdAtMs = Date.parse(String(root.createdAt ?? ""));
  const evaluatedAtMs = Date.parse(input.evaluatedAt);
  if (
    !Number.isFinite(createdAtMs) ||
    !Number.isFinite(evaluatedAtMs) ||
    createdAtMs > evaluatedAtMs + 5 * 60_000 ||
    evaluatedAtMs - createdAtMs > MOSS_PLUGIN_ACCESSIBILITY_MAX_AGE_MS
  ) {
    addIssue(issues, "Accessibility evidence is stale or has an invalid capture time.");
  }
  if (!validatesNoPrivateData(input.document)) {
    addIssue(issues, "Accessibility evidence contains private paths, credentials, or identities.");
  }

  const runner = record(root.runner);
  const renderedComponents = Array.isArray(runner?.renderedComponents)
    ? runner.renderedComponents.filter(string)
    : [];
  if (
    runner?.name !== "vitest-browser" ||
    runner.provider !== "playwright" ||
    runner.browser !== "chromium" ||
    runner.webdriver !== true ||
    runner.locale !== "en" ||
    runner.testFile !== "PluginAccessibility.browser.tsx" ||
    !string(runner.userAgent) ||
    !/Chrome\/[0-9.]+/.test(runner.userAgent) ||
    REQUIRED_MOSS_PLUGIN_ACCESSIBILITY_COMPONENTS.some(
      (component) => !renderedComponents.includes(component),
    )
  ) {
    addIssue(issues, "Accessibility evidence is not from the required real Chromium harness.");
  }

  const axe = record(root.axe);
  const axeScenarios = Array.isArray(axe?.scenarios) ? axe.scenarios : [];
  if (!exactScenarioSet(axeScenarios)) {
    addIssue(issues, "Axe evidence must contain every required plugin scenario exactly once.");
  }
  for (const scenarioValue of axeScenarios) {
    const scenario = record(scenarioValue);
    const testEngine = record(scenario?.testEngine);
    const violations = Array.isArray(scenario?.violations) ? scenario.violations : null;
    let validScenario =
      scenario !== null &&
      REQUIRED_MOSS_PLUGIN_ACCESSIBILITY_SCENARIOS.includes(
        scenario.id as MossPluginAccessibilityScenarioId,
      ) &&
      testEngine?.name === "axe-core" &&
      string(testEngine.version) &&
      SEMVER_PATTERN.test(testEngine.version) &&
      violations !== null;
    if (violations) {
      for (const violationValue of violations) {
        const violation = record(violationValue);
        const nodes = Array.isArray(violation?.nodes) ? violation.nodes : null;
        const impact = violation?.impact;
        let effectiveImpact = impact;
        if (
          !violation ||
          !string(violation.id) ||
          !AXE_IMPACTS.has(impact) ||
          !Array.isArray(violation.tags) ||
          !violation.tags.every(string) ||
          !string(violation.help) ||
          !string(violation.helpUrl) ||
          nodes === null ||
          nodes.length === 0
        ) {
          validScenario = false;
          continue;
        }
        for (const nodeValue of nodes) {
          const node = record(nodeValue);
          const nodeImpact = node?.impact;
          if (
            AXE_IMPACTS.has(nodeImpact) &&
            (AXE_IMPACT_RANK.get(nodeImpact) ?? -1) > (AXE_IMPACT_RANK.get(effectiveImpact) ?? -1)
          ) {
            effectiveImpact = nodeImpact;
          }
          if (
            !node ||
            !AXE_IMPACTS.has(nodeImpact) ||
            !Array.isArray(node.target) ||
            node.target.length === 0 ||
            !node.target.every(string) ||
            !string(node.html) ||
            !(node.failureSummary === null || string(node.failureSummary))
          ) {
            validScenario = false;
          }
        }
        if (effectiveImpact === "serious") serious += 1;
        if (effectiveImpact === "critical") critical += 1;
      }
    }
    if (validScenario) scenariosPassed += 1;
    else addIssue(issues, `Axe scenario ${String(scenario?.id ?? "unknown")} is malformed.`);
  }

  const keyboard = record(root.keyboard);
  const journeys = Array.isArray(keyboard?.journeys) ? keyboard.journeys : [];
  for (const [scenario, requiredControls] of Object.entries(
    REQUIRED_MOSS_PLUGIN_KEYBOARD_CONTROLS,
  )) {
    const matches = journeys.filter((value) => record(value)?.scenario === scenario);
    const journey = record(matches[0]);
    const actualValues = Array.isArray(journey?.actual) ? journey.actual : [];
    const actual = actualValues.map(identity).filter((value) => value !== null);
    if (
      matches.length !== 1 ||
      actual.length !== actualValues.length ||
      requiredControls.some((control) => !containsIdentity(actual, control))
    ) {
      addIssue(issues, `Keyboard journey ${scenario} is incomplete or contains invalid controls.`);
    }
  }

  const focusAppearance = Array.isArray(keyboard?.focusAppearance) ? keyboard.focusAppearance : [];
  const requiredFocusControls = Object.entries(REQUIRED_MOSS_PLUGIN_KEYBOARD_CONTROLS).flatMap(
    ([scenario, controls]) => controls.map((control) => ({ scenario, control })),
  );
  for (const { scenario, control: requiredControl } of requiredFocusControls) {
    const measurement = focusAppearance.find((value) => {
      const control = identity(record(value)?.control);
      return (
        record(value)?.scenario === scenario && control && sameIdentity(control, requiredControl)
      );
    });
    const before = styleSnapshot(record(measurement)?.before);
    const focused = styleSnapshot(record(measurement)?.focused);
    if (!before || !focused || !hasMeasuredFocusIndicator(before, focused)) {
      addIssue(
        issues,
        `Visible focus appearance was not measured for ${requiredControl.role} ${requiredControl.name}.`,
      );
    }
  }

  const dialog = record(root.dialog);
  const trigger = identity(dialog?.trigger);
  const initialFocus = identity(dialog?.initialFocus);
  const restoredFocus = identity(dialog?.restoredFocus);
  const forwardTabSequence = Array.isArray(dialog?.forwardTabSequence)
    ? dialog.forwardTabSequence.map(identity).filter((value) => value !== null)
    : [];
  const reverseTabSequence = Array.isArray(dialog?.reverseTabSequence)
    ? dialog.reverseTabSequence.map(identity).filter((value) => value !== null)
    : [];
  const backgroundTabStops = Array.isArray(dialog?.backgroundTabStops)
    ? dialog.backgroundTabStops.map(identity).filter((value) => value !== null)
    : [];
  const requiredDialogActions = [
    { role: "button", name: "Connect" },
    { role: "button", name: "View details" },
    { role: "button", name: "Try GitHub now" },
    { role: "button", name: "Close" },
  ];
  if (
    !trigger ||
    !sameIdentity(trigger, { role: "button", name: "Install GitHub" }) ||
    dialog?.role !== "dialog" ||
    dialog.name !== "Connect your apps to GitHub" ||
    dialog.ariaModal !== "true" ||
    !initialFocus ||
    !containsIdentity(requiredDialogActions, initialFocus) ||
    requiredDialogActions.some(
      (control) =>
        !containsIdentity(forwardTabSequence, control) ||
        !containsIdentity(reverseTabSequence, control),
    ) ||
    backgroundTabStops.length !== 0 ||
    !finiteNumber(dialog.backgroundInertAncestorCount) ||
    dialog.backgroundInertAncestorCount < 1 ||
    dialog.afterEscapeDialogCount !== 0 ||
    !restoredFocus ||
    !sameIdentity(restoredFocus, trigger)
  ) {
    addIssue(issues, "Install auth dialog focus entry, trap, role, escape, or restoration failed.");
  }

  const semantics = record(root.semantics);
  const controls = Array.isArray(semantics?.controls) ? semantics.controls : [];
  for (const required of REQUIRED_MOSS_PLUGIN_SEMANTICS) {
    const match = controls.find((value) => {
      const control = record(value);
      return (
        control?.scenario === required.scenario &&
        control.role === required.role &&
        control.name === required.name
      );
    });
    const measured = record(match);
    if (!measured || ("selected" in required && measured.selected !== required.selected)) {
      addIssue(
        issues,
        `Required semantic ${required.scenario}/${required.role}/${required.name} is missing or wrong.`,
      );
    }
  }

  const announcements = Array.isArray(root.announcements) ? root.announcements : [];
  for (const required of REQUIRED_MOSS_PLUGIN_ANNOUNCEMENTS) {
    const measured = announcements.find((value) => {
      const announcement = record(value);
      return announcement?.scenario === required.scenario && announcement.role === required.role;
    });
    const announcement = record(measured);
    if (
      !announcement ||
      !string(announcement.text) ||
      announcement.text.trim().length === 0 ||
      (required.role === "status" && announcement.ariaLive !== "polite")
    ) {
      addIssue(issues, `Required ${required.scenario} ${required.role} announcement is missing.`);
    }
  }

  const zoom = Array.isArray(root.zoom) ? root.zoom : [];
  for (const [scenario, requiredActions] of Object.entries(REQUIRED_MOSS_PLUGIN_ZOOM_ACTIONS)) {
    const matches = zoom.filter((value) => record(value)?.scenario === scenario);
    const measurement = record(matches[0]);
    const actionNames = Array.isArray(measurement?.actionNames)
      ? measurement.actionNames.filter(string)
      : [];
    const visibleActionNames = Array.isArray(measurement?.visibleActionNames)
      ? measurement.visibleActionNames.filter(string)
      : [];
    const clippedActionNames = Array.isArray(measurement?.clippedActionNames)
      ? measurement.clippedActionNames.filter(string)
      : [];
    if (
      matches.length !== 1 ||
      measurement?.scalePercent !== 200 ||
      measurement.sourceViewportWidth !== 1280 ||
      measurement.cssViewportWidth !== 640 ||
      !finiteNumber(measurement.documentClientWidth) ||
      !finiteNumber(measurement.documentScrollWidth) ||
      measurement.documentScrollWidth > measurement.documentClientWidth ||
      !finiteNumber(measurement.surfaceClientWidth) ||
      !finiteNumber(measurement.surfaceScrollWidth) ||
      measurement.surfaceScrollWidth > measurement.surfaceClientWidth ||
      clippedActionNames.length !== 0 ||
      requiredActions.some(
        (action) => !actionNames.includes(action) || !visibleActionNames.includes(action),
      )
    ) {
      addIssue(issues, `Measured 200% zoom/reflow failed for ${scenario}.`);
    }
  }

  const targetSize = Array.isArray(root.targetSize) ? root.targetSize : [];
  const requiredTargetControls = [
    ...requiredFocusControls,
    {
      scenario: "install-auth-dialog",
      control: { role: "button", name: "Connect" },
    },
    {
      scenario: "install-auth-dialog",
      control: { role: "button", name: "View details" },
    },
    {
      scenario: "install-auth-dialog",
      control: { role: "button", name: "Try GitHub now" },
    },
    {
      scenario: "install-auth-dialog",
      control: { role: "button", name: "Close" },
    },
  ];
  for (const { scenario, control: requiredControl } of requiredTargetControls) {
    const measurement = targetSize.find((value) => {
      const control = identity(record(value)?.control);
      return (
        record(value)?.scenario === scenario && control && sameIdentity(control, requiredControl)
      );
    });
    const measured = record(measurement);
    if (
      !measured ||
      !finiteNumber(measured.width) ||
      !finiteNumber(measured.height) ||
      measured.width < 24 ||
      measured.height < 24
    ) {
      addIssue(
        issues,
        `Target size was not measured at 24x24 CSS pixels for ${requiredControl.name}.`,
      );
    }
  }

  if (serious !== 0 || critical !== 0) {
    addIssue(issues, "Axe serious or critical violations remain.");
  }

  return {
    issues,
    serious,
    critical,
    scenariosPassed,
    scenariosTotal: REQUIRED_MOSS_PLUGIN_ACCESSIBILITY_SCENARIOS.length,
  };
}
