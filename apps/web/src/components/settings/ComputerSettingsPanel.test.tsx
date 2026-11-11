// FILE: ComputerSettingsPanel.test.tsx
// Purpose: Guards Settings › Computer use: the "any app" switch, at most one plain status
//          line with one action, and the developer text it must never show again
//          (provisioning instructions, backend names, raw errors, ability read-outs).
// Layer: Component rendering tests
// Depends on: ComputerSettingsPanel and React server rendering.
//
// Rendered to static markup with the status query primed, which is enough for
// every question worth asking of this panel: it is a read-out, and what it
// reads out is decided at render time. Interaction (pressing Set up) belongs to
// `useProvisionComputer.test.tsx`, which owns that mutation.

import type { ComputerStatusResult } from "@moss/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import {
  AppSettingsSchema,
  applyLocalAppSettingsPatch,
  resolveAgentCursorColors,
  type AppSettings,
  type AppSettingsBinding,
} from "~/appSettings";
import { serverQueryKeys } from "~/lib/serverReactQuery";
import { ComputerSettingsPanel, resolveComputerUseStatusLine } from "./ComputerSettingsPanel";

vi.mock("~/components/ui/toast", () => ({ toastManager: { add: vi.fn() } }));

function capabilities(overrides: Partial<ComputerStatusResult["capabilities"]> = {}) {
  return {
    windows: true,
    windowBounds: true,
    stacking: true,
    capture: true,
    input: true,
    clipboard: true,
    focus: true,
    raise: true,
    ghostCursor: true,
    visibleDesktop: true,
    ...overrides,
  };
}

function status(overrides: Partial<ComputerStatusResult> = {}): ComputerStatusResult {
  return {
    computerId: "desktop",
    availability: { kind: "available", backend: "mac" },
    capabilities: capabilities(),
    health: { status: "connected", consecutiveFailures: 0, reconnects: 0, captureAvailable: true },
    ...overrides,
  };
}

function binding(overrides: Partial<AppSettings> = {}): AppSettingsBinding {
  return {
    settings: { autoOpenComputerPane: true, computerControlEnabled: true, ...overrides },
    defaults: { autoOpenComputerPane: true, computerControlEnabled: false },
    updateSettings: vi.fn(),
  } as unknown as AppSettingsBinding;
}

function render(input: {
  readonly status?: ComputerStatusResult;
  readonly active?: boolean;
  readonly settings?: Partial<AppSettings>;
}) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  if (input.status) queryClient.setQueryData(serverQueryKeys.computerStatus(), input.status);
  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <ComputerSettingsPanel {...binding(input.settings)} active={input.active ?? true} />
    </QueryClientProvider>,
  );
}

describe("ComputerSettingsPanel", () => {
  it("renders nothing while the panel is not the active one", () => {
    // The status query is gated on the same flag; a panel nobody is looking at
    // must not poll a backend awake.
    expect(render({ status: status(), active: false })).toBe("");
  });

  it("shows the switch and nothing else while the desktop is ready", () => {
    const markup = render({ status: status() });
    expect(markup).toContain("Any app");
    expect(markup).toContain("Let Moss use the apps on your computer");
    expect(markup).not.toContain('data-testid="computer-use-status"');
    expect(markup).not.toContain("Set up");
    expect(markup).not.toContain("Capabilities");
    expect(markup).not.toContain("Getting started");
  });

  it("stays calm while computer use simply has not started yet", () => {
    // After a restart the backend is idle; it starts the first time a chat needs it.
    const markup = render({
      status: status({
        health: {
          status: "unavailable",
          consecutiveFailures: 0,
          reconnects: 0,
          captureAvailable: false,
        },
      }),
    });
    expect(markup).not.toContain('data-testid="computer-use-status"');
  });

  it("asks for permission in one line with one button", () => {
    const markup = render({
      status: status({
        availability: {
          kind: "permission-required",
          missing: ["accessibility", "screenRecording"],
          message: "macOS is asking for Accessibility.",
          buildSignature: "adhoc",
        },
      }),
    });
    expect(markup).toContain("Moss needs your permission to use other apps");
    expect(markup).toContain("Allow access");
    expect(markup).not.toContain("macOS is asking for Accessibility.");
    expect(markup.match(/data-testid="computer-use-status"/g) ?? []).toHaveLength(1);
  });

  it("says the screen can't be seen, without technical detail", () => {
    const markup = render({
      status: status({
        health: {
          status: "connected",
          consecutiveFailures: 0,
          reconnects: 0,
          captureAvailable: false,
        },
      }),
    });
    expect(markup).toContain("Moss can&#x27;t see the screen yet");
    expect(markup).toContain("Allow access");
    expect(markup).not.toContain("Privacy &amp; Security");
  });

  it("never shows the driver's provisioning text or raw errors", () => {
    const markup = render({
      status: status({
        availability: {
          kind: "backend-unavailable",
          message:
            "Cua Driver is not bundled. Run the provisioning script (`node apps/desktop/scripts/provision-cua-driver.mjs`, needs the pinned Rust toolchain) in this checkout, then relaunch Moss.",
        },
      }),
    });
    expect(markup).toContain("Computer use isn&#x27;t working right now");
    expect(markup).toContain("Try again");
    expect(markup).not.toContain("Cua");
    expect(markup).not.toContain("provision");
    expect(markup).not.toContain("Rust");
  });

  it("says what is missing when the backend knows, still without its English text", () => {
    const missing = render({
      status: status({
        availability: {
          kind: "backend-unavailable",
          message:
            "Cua Driver is not staged in this checkout. Relaunch the dev window (it downloads the pinned, checksum-verified driver), or run `node apps/desktop/scripts/provision-cua-driver.mjs`.",
          reason: "component-missing",
        },
      }),
    });
    expect(missing).toContain(
      "Moss is missing its computer control part. Restart or reinstall Moss",
    );
    expect(missing).toContain("Try again");
    expect(missing).not.toContain("Cua");
    expect(missing).not.toContain("provision");
    const notStarted = render({
      status: status({
        availability: {
          kind: "backend-unavailable",
          message: "Moss's computer control is not running yet. Restart Moss, then refresh.",
          reason: "host-not-running",
        },
      }),
    });
    expect(notStarted).toContain("Computer control didn&#x27;t start. Restart Moss");
  });

  it("does not read out the backend or its abilities", () => {
    const markup = render({
      status: status({
        availability: { kind: "available", backend: "cua" },
        hostPlatform: "win32",
        capabilities: capabilities({ input: false }),
      }),
    });
    expect(markup).not.toContain("Cua 0.28.2");
    expect(markup).not.toContain("UI Automation");
    expect(markup).not.toContain("native desktop input");
  });

  it("maps every state to at most one plain line", () => {
    const base = {
      queryFailed: false,
      availabilityKind: "available",
      viewKind: "ready",
      reconnecting: false,
      missingPermissions: false,
      captureBlocked: false,
      needsSetup: false,
    } as const;
    expect(resolveComputerUseStatusLine(base)).toBeNull();
    expect(
      resolveComputerUseStatusLine({ ...base, viewKind: "checking", needsSetup: true }),
    ).toBeNull();
    expect(resolveComputerUseStatusLine({ ...base, queryFailed: true })?.action).toBe("retry");
    expect(
      resolveComputerUseStatusLine({ ...base, availabilityKind: "unsupported-platform" })?.action,
    ).toBeNull();
    expect(resolveComputerUseStatusLine({ ...base, reconnecting: true })?.text).toBe(
      "Reconnecting…",
    );
    // A known reason is looked at again, never sent through setup.
    for (const unavailableReason of ["component-missing", "host-not-running"] as const) {
      expect(
        resolveComputerUseStatusLine({
          ...base,
          availabilityKind: "backend-unavailable",
          unavailableReason,
        })?.action,
      ).toBe("recheck");
    }
    expect(
      resolveComputerUseStatusLine({ ...base, availabilityKind: "backend-unavailable" })?.action,
    ).toBe("retry");
  });

  describe("agent cursor colors", () => {
    it("keeps the pointer at its default and hides the color editors", () => {
      const markup = render({ status: status() });
      expect(markup).toContain("Pointer color");
      expect(markup).toContain("Default");
      expect(markup).toContain("Custom");
      // Default is the zero-override state: no fill/rim editor renders and no
      // stored color is read out.
      expect(markup).not.toContain("Fill color");
      expect(markup).not.toContain("Rim color");
      expect(markup).not.toContain("data-swatch");
    });

    it("round-trips custom colors through the settings store", () => {
      const defaults = AppSettingsSchema.makeUnsafe({});
      // The default is stock with no overrides stored.
      expect(defaults.agentCursorColorMode).toBe("stock");
      expect(defaults.agentCursorFillColor).toBe("");
      expect(defaults.agentCursorRimColor).toBe("");
      expect(resolveAgentCursorColors(defaults)).toBeNull();

      const stored = applyLocalAppSettingsPatch(defaults, {
        agentCursorColorMode: "custom",
        agentCursorFillColor: "#AABBCC",
        agentCursorRimColor: "not-a-color",
      });
      expect(stored.agentCursorColorMode).toBe("custom");
      expect(stored.agentCursorFillColor).toBe("#aabbcc");
      // A value that is not a complete hex color never becomes a preference.
      expect(stored.agentCursorRimColor).toBe("");
      expect(resolveAgentCursorColors(stored)).toEqual({ fill: "#aabbcc" });

      // Stock means zero overrides even when colors are still remembered for
      // a later switch back to custom.
      const backToStock = applyLocalAppSettingsPatch(stored, {
        agentCursorColorMode: "stock",
      });
      expect(backToStock.agentCursorFillColor).toBe("#aabbcc");
      expect(resolveAgentCursorColors(backToStock)).toBeNull();
    });
  });
});
