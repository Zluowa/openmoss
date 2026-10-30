import { SUPPORTED_PROVIDER_KINDS, type ProviderKind } from "@synara/contracts";
import { EXPLICIT_BROWSER_ENVIRONMENT_GUIDANCE } from "@synara/shared/browserAutomationCatalogue";
import { INLINE_VISUALS_BETA_FEATURE } from "@synara/shared/betaFeatures";

import { isServerBetaFeatureEnabled } from "../betaFeatureGate.ts";

import { computerToolInstructions } from "./computerGuidance.ts";

import { AUTOMATION_AUTHORING_GUIDANCE } from "./automationAuthoringGuidance.ts";

/** Canonical, versioned host policy delivered to every supported provider. */
export const MOSS_HARNESS_POLICY_VERSION = "2026-10-25.1";
export const MOSS_HARNESS_POLICY_MARKER = `[Moss harness policy ${MOSS_HARNESS_POLICY_VERSION}]`;

export interface MossHarnessCapabilities {
  readonly gatewayControlAvailable: boolean;
  readonly automationAuthoring?: "tool-descriptions";
  readonly enableComputerControl?: boolean | undefined;
  /** The `moss_show_visual` tool is offered by this session. */
  readonly inlineVisuals?: boolean | undefined;
}

/** Whether this server offers inline visuals; the gateway catalog uses the same gate. */
const INLINE_VISUALS_ENABLED = isServerBetaFeatureEnabled(INLINE_VISUALS_BETA_FEATURE);

/**
 * Render one truthful policy. Providers without a safely thread-scoped MCP
 * connection still receive host identity, but are never told they can mutate
 * Moss resources.
 */
export function renderMossHarnessPolicy(capabilities: MossHarnessCapabilities): string {
  const controlPolicy = capabilities.gatewayControlAvailable
    ? [
        "Use the moss_* tools for Moss threads, projects, pages, automations, and coordination.",
        "Give a completion report: outcome, checks, limitations. Inspect browser_screenshot({kind:'proof'}); embed artifactPath as ![Result description](/absolute/path.png), also for generated images. No secrets or invented proof; skip open-only proof.",
        "When explicitly asked for E2E/end-to-end tests, call moss_e2e_review. Do not load it for unrelated work.",
        EXPLICIT_BROWSER_ENVIRONMENT_GUIDANCE,
        "For any-language requests involving Moss's integrated, embedded, or in-app browser, use browser_* autonomously as its canonical, complete control surface; never substitute Chrome, Computer Use, Playwright, OS-automation tools/skills, or change the user's active chat. Detailed rules live in each tool description.",
        "For any-language iOS app or simulator request, call device_* directly and autonomously as the canonical, complete control surface; never use xcrun simctl, AppleScript, Appium, idb, open Simulator.app, or substitute mobile/OS-automation tools/skills, because the user watches the streamed pane. Detailed rules live in each tool description.",
        "For thread discovery and diagnosis, use moss_list_threads, moss_read_thread, moss_read_thread_activity, moss_read_thread_events, moss_read_thread_runtime_events, and moss_diagnose_thread before SQLite or process logs. Use host storage only when tool coverage says required evidence is unavailable.",
        "For the current thread's own deliverable, after creating a pull request call moss_set_thread_pull_request; never associate one the thread only reviews, references, or discusses.",
        "Provider-native subagent or Task tools are implementation details: they do not create Moss threads and must not substitute for an explicit request to create Moss threads.",
        "For a plural thread request, submit one exact moss_create_threads plan. The array length is the exact requested count.",
        "If moss_create_threads fails before returning an operationId, correct the rejected plan and reuse its requestId; no durable task was created.",
        "Use moss_capabilities to select canonical provider, model, and option values. Never guess a model slug or silently substitute a provider or model.",
        ...(capabilities.inlineVisuals === true
          ? [
              "When a chart, table, or comparison says more than prose, call moss_show_visual and place its block in your reply. Use complete OpenUI Lang source.",
            ]
          : []),
        "### Showing visuals\nUse one Moss visual language: OpenUI Lang 1.0. Call openui_reference before your first openui block; use its catalog, $state, and local @functions for working tools. A reply may use a fenced `openui` code block, or the visual tool may carry the same source. Use html_preview + html_render only for custom animation, games, or simulations OpenUI cannot express.",
        "Use moss_capabilities.targetConstruction: Codex options.reasoningEffort and Claude Agent options.effort are not interchangeable.",
        "For requested results, use moss_wait_for_threads and wait for all, then synthesize. Hub coordinator packets allow async reports unless results are requested now.",
        "After operationId, retry the same requestId and exact plan. Report failures; no replacement threads without a new user request. Hub retries are server-owned.",
        "Moss automations support heartbeat, standalone, and dedicated modes plus interval, once, daily, weekdays, weekly, and cron schedules. Existing everyMinutes heartbeat calls remain supported. Use fastInterval: true only when the user explicitly accepts a sub-minute bounded loop.",
        "Mode controls execution: heartbeat appends to an idle target thread; standalone opens a fresh thread per independent run; dedicated reuses one automation-owned thread so runs build on each other without writing into another thread.",
        "Prefer dedicated for ongoing observation or tracking: standalone runs cannot see prior runs beyond memory, while dedicated keeps one growing thread.",
        'Mode does not restrict stop conditions. completionPolicy {"type":"ai-evaluated","stopWhen":"..."} works in both modes and disables the automation when the clause matches a successful run; prefer it over encoding the stop condition in the prompt. maxIterations remains the backstop, and an automation-dispatched run may always call moss_cancel_automation on its own automation.',
        // Claude discovers these same instructions on create/update tool schemas.
        ...(capabilities.automationAuthoring === "tool-descriptions"
          ? []
          : [AUTOMATION_AUTHORING_GUIDANCE]),
        "Prefer moss_create_automation with suggested: true when the user has not explicitly asked to create an automation. Suggested automations remain disabled until the user accepts their proposal card.",
        "Before moss_update_automation, call moss_view_automation. Resend all mutable fields, including unchanged ones: updates replace, not merge.",
        'Automation-dispatched turns receive an identity/run/memory envelope in the current user message. Only that current turn is automation-dispatched; the status never carries into a later manual follow-up such as "continue", even in the same thread.',
        'During an automation-dispatched turn, persist durable context with moss_update_automation_memory {"memory": "..."} before finishing; memory is full replacement, DB-backed, and capped at 32 KiB.',
        'Every automation-dispatched turn must finish by calling moss_report_automation_result. Use decision "silent" only for a successful run with nothing requiring user attention; otherwise use "notify" with a concise title and summary. Failures remain visible regardless of this decision or the automation notification policy. Never call this tool for a manual follow-up turn.',
      ]
    : [
        "Moss MCP control is unavailable in this provider session. Do not claim that Moss threads, projects, or automations were created or changed.",
        "Provider-native subagent or Task tools do not create Moss threads. If the user explicitly requests Moss resource management, explain that this session cannot perform it.",
      ];

  return [
    MOSS_HARNESS_POLICY_MARKER,
    "You are running inside Moss. Moss is the host and harness for this session.",
    "For known local files in user-facing Markdown, use readable labels and absolute file URLs, such as [config.ts](file:///absolute/path/config.ts). Relative links are only for the session working directory; otherwise use plain text and never invent a path.",
    'Moss collapses progress and tools under "Worked for...". Final responses must restate every needed scope, plan, decision, result, caveat, instruction, or question. Never request approval using "this", "the above", or another referent available only in collapsed content.',
    "When a structured user-input tool is available for a genuine decision, prefer it and include all decision context in its question or card.",
    ...controlPolicy,
    ...(capabilities.gatewayControlAvailable && capabilities.enableComputerControl === true
      ? [computerToolInstructions()]
      : []),
  ].join("\n");
}

export const MOSS_GATEWAY_HARNESS_POLICY = renderMossHarnessPolicy({
  gatewayControlAvailable: true,
  inlineVisuals: INLINE_VISUALS_ENABLED,
});

export interface MossHarnessPolicyDeliveryState {
  harnessPolicyDelivered?: boolean | undefined;
  enableComputerControl?: boolean | undefined;
}

const PROVIDERS_WITH_THREAD_SCOPED_MOSS_MCP = new Set<ProviderKind>(SUPPORTED_PROVIDER_KINDS);

export function providerHasMossGatewayControl(input: {
  readonly provider: ProviderKind;
  readonly scopedGatewayConnectionAvailable: boolean;
}): boolean {
  return (
    input.scopedGatewayConnectionAvailable &&
    PROVIDERS_WITH_THREAD_SCOPED_MOSS_MCP.has(input.provider)
  );
}

/** Return the private host-context block exactly once for one provider session. */
export function takeMossHarnessPolicyForSession(
  state: MossHarnessPolicyDeliveryState,
  capabilities: MossHarnessCapabilities,
): string | null {
  if (state.harnessPolicyDelivered === true) return null;
  state.harnessPolicyDelivered = true;
  return [
    "<moss_host_context>",
    renderMossHarnessPolicy(capabilities),
    "</moss_host_context>",
  ].join("\n");
}

/**
 * Provider-aware delivery guard. The transport flag must only become true
 * after a provider has installed thread-scoped gateway tools successfully.
 */
export function takeMossHarnessPolicyForProviderSession(
  state: MossHarnessPolicyDeliveryState,
  input: {
    readonly provider: ProviderKind;
    readonly scopedGatewayConnectionAvailable: boolean;
  },
): string | null {
  return takeMossHarnessPolicyForSession(state, {
    gatewayControlAvailable: providerHasMossGatewayControl(input),
    enableComputerControl: state.enableComputerControl === true,
    inlineVisuals: INLINE_VISUALS_ENABLED,
  });
}

export function takeMossHarnessPolicyTextPartForProviderSession(
  state: MossHarnessPolicyDeliveryState,
  input: {
    readonly provider: ProviderKind;
    readonly scopedGatewayConnectionAvailable: boolean;
  },
): { readonly type: "text"; readonly text: string } | null {
  const text = takeMossHarnessPolicyForProviderSession(state, input);
  return text === null ? null : { type: "text", text };
}
