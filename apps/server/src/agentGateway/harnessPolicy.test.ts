import { assert, describe, it } from "@effect/vitest";
import { ProviderKind, RETIRED_PROVIDER_KINDS, SUPPORTED_PROVIDER_KINDS } from "@synara/contracts";
import { Schema } from "effect";
import { AUTOMATION_AUTHORING_GUIDANCE } from "./automationAuthoringGuidance.ts";

import {
  renderMossHarnessPolicy,
  MOSS_HARNESS_POLICY_MARKER,
  takeMossHarnessPolicyForProviderSession,
  takeMossHarnessPolicyTextPartForProviderSession,
  takeMossHarnessPolicyForSession,
  providerHasMossGatewayControl,
} from "./harnessPolicy.ts";

describe("Moss harness policy", () => {
  it("defers duplicate automation authoring text while preserving tool routing and run rules", () => {
    const inline = renderMossHarnessPolicy({ gatewayControlAvailable: true });
    const deferred = renderMossHarnessPolicy({
      gatewayControlAvailable: true,
      automationAuthoring: "tool-descriptions",
    });
    assert.equal(deferred, inline.replace(`${AUTOMATION_AUTHORING_GUIDANCE}\n`, ""));
    assert.include(deferred, "moss_create_automation");
    assert.include(deferred, "moss_view_automation");
    assert.include(deferred, "moss_report_automation_result");
  });

  it("includes honest completion evidence and opt-in delegated E2E testing", () => {
    const policy = renderMossHarnessPolicy({ gatewayControlAvailable: true });
    for (const text of [
      "completion report",
      "artifactPath",
      "![Result description]",
      "explicitly asked",
      "moss_e2e_review",
      "Do not load it for unrelated work",
    ]) {
      assert.include(policy, text);
    }
    assert.notInclude(
      renderMossHarnessPolicy({ gatewayControlAvailable: false }),
      "browser_screenshot({kind:'proof'})",
    );
  });

  it("identifies Moss and explains exact batch coordination when MCP is available", () => {
    const policy = renderMossHarnessPolicy({ gatewayControlAvailable: true });
    assert.include(policy, MOSS_HARNESS_POLICY_MARKER);
    assert.include(policy, "Moss is the host and harness");
    assert.include(policy, "one exact moss_create_threads plan");
    assert.include(policy, "before returning an operationId");
    assert.include(policy, "moss_wait_for_threads");
    assert.include(policy, "moss_set_thread_pull_request");
    assert.include(policy, "current thread's own deliverable");
    assert.include(policy, "only reviews, references, or discusses");
    assert.include(policy, "Explicit browser or environment choice wins");
    assert.include(policy, "do not create a new default");
    assert.notInclude(
      renderMossHarnessPolicy({ gatewayControlAvailable: false }),
      "Explicit browser or environment choice wins",
    );
    assert.include(policy, "use browser_* autonomously");
    assert.include(policy, "canonical, complete control surface");
    assert.include(policy, "never substitute Chrome");
    assert.include(policy, "user's active chat");
    assert.include(policy, "Detailed rules live in each tool description");
    assert.notInclude(policy, "BrowserInterruptedByHuman");
    assert.notInclude(policy, "start with browser_open");
    assert.include(policy, "do not create Moss threads");
    assert.include(policy, "specific 3–8 word outcome label");
    assert.include(policy, "Assume no chat context");
    assert.include(policy, "notify-versus-silent criteria");
    assert.include(policy, 'later manual follow-up such as "continue"');
    assert.include(policy, "Never call this tool for a manual follow-up turn");
  });

  it("asks agents to emit known absolute file URLs instead of invented relative links", () => {
    const gateway = renderMossHarnessPolicy({ gatewayControlAvailable: true });
    const identityOnly = renderMossHarnessPolicy({ gatewayControlAvailable: false });

    for (const policy of [gateway, identityOnly]) {
      assert.include(policy, "[config.ts](file:///absolute/path/config.ts)");
      assert.include(policy, "Relative links are only for the session working directory");
      assert.include(policy, "use plain text and never invent a path");
    }
  });

  it("keeps final answers self-contained when intermediate progress is collapsed", () => {
    const gateway = renderMossHarnessPolicy({ gatewayControlAvailable: true });
    const identityOnly = renderMossHarnessPolicy({ gatewayControlAvailable: false });

    for (const policy of [gateway, identityOnly]) {
      assert.include(policy, 'under "Worked for..."');
      assert.include(policy, "Final responses must restate every needed scope");
      assert.include(policy, 'Never request approval using "this", "the above"');
      assert.include(policy, "structured user-input tool");
      assert.include(policy, "include all decision context");
    }
  });

  it("never advertises gateway mutation to providers without scoped MCP", () => {
    const policy = renderMossHarnessPolicy({ gatewayControlAvailable: false });
    assert.include(policy, "Moss MCP control is unavailable");
    assert.notInclude(policy, "one exact moss_create_threads plan");
  });

  it("delivers a private host-context block once per provider session", () => {
    const state: { harnessPolicyDelivered?: boolean } = {};
    assert.include(
      takeMossHarnessPolicyForSession(state, { gatewayControlAvailable: true }) ?? "",
      "<moss_host_context>",
    );
    assert.isNull(takeMossHarnessPolicyForSession(state, { gatewayControlAvailable: true }));

    // The text-part form ACP adapters inject obeys the same once-per-session latch.
    const partState: { harnessPolicyDelivered?: boolean } = {};
    const input = { provider: "cursor", scopedGatewayConnectionAvailable: true } as const;
    assert.include(
      takeMossHarnessPolicyTextPartForProviderSession(partState, input)?.text ?? "",
      MOSS_HARNESS_POLICY_MARKER,
    );
    assert.isNull(takeMossHarnessPolicyTextPartForProviderSession(partState, input));
  });

  it("keeps OpenCode and Pi identity-only until scoped setup succeeds", () => {
    for (const provider of ["opencode", "pi"] as const) {
      const text =
        takeMossHarnessPolicyForProviderSession(
          {},
          { provider, scopedGatewayConnectionAvailable: false },
        ) ?? "";
      assert.include(text, MOSS_HARNESS_POLICY_MARKER, provider);
      assert.include(text, "Moss MCP control is unavailable", provider);
      assert.notInclude(text, "one exact moss_create_threads plan", provider);
    }
  });

  it("routes iOS work to device tools without embedding per-tool instructions", () => {
    const policy = renderMossHarnessPolicy({ gatewayControlAvailable: true });
    assert.include(policy, "any-language iOS app or simulator request");
    assert.include(policy, "call device_* directly and autonomously");
    assert.include(policy, "never use xcrun simctl");
    assert.include(policy, "open Simulator.app");
    assert.include(policy, "user watches the streamed pane");
    assert.notInclude(policy, "device_list first");
    assert.notInclude(policy, "com.apple.Preferences");
  });

  it("offers moss_show_visual and keeps OpenUI and html_render as the fallback", () => {
    const gateway = renderMossHarnessPolicy({
      gatewayControlAvailable: true,
      inlineVisuals: true,
    });
    assert.include(
      gateway,
      "When a chart, table, or comparison says more than prose, call moss_show_visual and place its block in your reply.",
    );
    assert.include(gateway, "### Showing visuals");
    assert.include(gateway, "fenced `openui` code block");
    assert.include(gateway, "Call openui_reference before your first openui block");
    assert.include(gateway, "html_preview + html_render");
    assert.notInclude(
      renderMossHarnessPolicy({ gatewayControlAvailable: true }),
      "moss_show_visual",
    );
    assert.notInclude(renderMossHarnessPolicy({ gatewayControlAvailable: false }), "html_render");
    assert.notInclude(
      renderMossHarnessPolicy({ gatewayControlAvailable: false }),
      "openui_reference",
    );
  });

  it("teaches one OpenUI visual contract instead of the legacy blocks schema", () => {
    const policy = renderMossHarnessPolicy({
      gatewayControlAvailable: true,
      inlineVisuals: true,
    });
    assert.include(policy, "one Moss visual language: OpenUI Lang 1.0");
    assert.include(policy, "same source");
    assert.include(policy, "$state");
    assert.notInclude(policy, "stats {items:");
    assert.notInclude(policy, "bar-chart {title?");
    assert.notInclude(policy, "blocks:[...");
  });

  it("keeps the gateway policy below its prompt budget", () => {
    // Includes the T3-compatible visual-reply workflow, including html_preview
    // and the openui_reference catalog pointer.
    assert.isAtMost(renderMossHarnessPolicy({ gatewayControlAvailable: true }).length, 6_400);
  });

  it("withholds device guidance from sessions with no gateway control", () => {
    const policy = renderMossHarnessPolicy({ gatewayControlAvailable: false });

    // Promising tools this session cannot reach would be a lie.
    assert.notInclude(policy, "device_list");
    assert.notInclude(policy, "device_describe_ui");
  });

  it("includes Computer tool guidance only when the session can use Computer", () => {
    for (const gatewayControlAvailable of [true, false] as const) {
      for (const enableComputerControl of [true, false, undefined] as const) {
        const policy = renderMossHarnessPolicy({
          gatewayControlAvailable,
          ...(enableComputerControl === undefined ? {} : { enableComputerControl }),
        });
        const scope = `${gatewayControlAvailable}/${enableComputerControl}`;
        if (gatewayControlAvailable && enableComputerControl === true) {
          assert.include(policy, "## Moss computer use", scope);
          assert.include(policy, "The computer_* tools are live on this session", scope);
        } else {
          assert.notInclude(policy, "## Moss computer use", scope);
          assert.notInclude(policy, "computer_", scope);
          assert.notInclude(policy, "turn Computer control on in Settings", scope);
        }
      }
    }
  });
});

it("adds Computer guidance only for an explicitly enabled scoped session across all providers", () => {
  const providers = SUPPORTED_PROVIDER_KINDS;
  for (const provider of providers) {
    const off = takeMossHarnessPolicyForProviderSession(
      {},
      { provider, scopedGatewayConnectionAvailable: true },
    );
    const explicitOff = takeMossHarnessPolicyForProviderSession(
      { enableComputerControl: false },
      { provider, scopedGatewayConnectionAvailable: true },
    );
    assert.strictEqual(off, explicitOff);
    assert.notInclude(off ?? "", "## Moss computer use");
    assert.notInclude(off ?? "", "computer_", provider);
    const state = { enableComputerControl: true };
    const on =
      takeMossHarnessPolicyForProviderSession(state, {
        provider,
        scopedGatewayConnectionAvailable: true,
      }) ?? "";
    assert.equal(on.split("## Moss computer use").length - 1, 1, provider);
    assert.include(on, "never replay it");
    assert.isNull(
      takeMossHarnessPolicyForProviderSession(state, {
        provider,
        scopedGatewayConnectionAvailable: true,
      }),
    );
    assert.notInclude(
      takeMossHarnessPolicyForProviderSession(
        { enableComputerControl: true },
        { provider, scopedGatewayConnectionAvailable: false },
      ) ?? "",
      "## Moss computer use",
    );
  }
});

it("keeps retired driver history decodable without granting new gateway authority", () => {
  for (const provider of RETIRED_PROVIDER_KINDS) {
    assert.strictEqual(Schema.decodeUnknownSync(ProviderKind)(provider), provider);
    assert.isFalse(
      providerHasMossGatewayControl({ provider, scopedGatewayConnectionAvailable: true }),
    );
    const policy =
      takeMossHarnessPolicyForProviderSession(
        { enableComputerControl: true },
        { provider, scopedGatewayConnectionAvailable: true },
      ) ?? "";
    assert.include(policy, "Moss MCP control is unavailable");
    assert.notInclude(policy, "## Moss computer use");
  }
});
