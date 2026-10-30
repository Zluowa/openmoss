import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page,
} from "playwright/test";

const WEB_DIR = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const REPO_ROOT = resolve(WEB_DIR, "../..");
const DESKTOP_DIR = resolve(REPO_ROOT, "apps/desktop");
const requireFromDesktop = createRequire(resolve(DESKTOP_DIR, "package.json"));
const EVIDENCE_DIR = resolve(REPO_ROOT, ".tmp/ui-parity");

type FixtureState = {
  readonly activeGuests: number;
  readonly pendingAttach: number;
  readonly registeredPartitions: number;
  readonly partitionPolicies: number;
  readonly registerCount: number;
  readonly diagnostics: {
    readonly configuredGuestPreloadPath: string;
    readonly configuredAnnotationPreloadPath: string;
    readonly rendererCssInjected: boolean;
    readonly runtimeGuestPreloadPaths: readonly string[];
    readonly guestMessage: number;
    readonly willAttachPreferences: ReadonlyArray<{
      readonly preload: string;
      readonly sandbox: boolean;
      readonly partition: string;
    }>;
    readonly didAttachSessionMatches: readonly boolean[];
    readonly preloadErrors: readonly string[];
    readonly guestConsoleErrors: readonly string[];
    readonly guestConsoleWarnings: readonly string[];
    readonly guestConsoleSecurityDenials: readonly string[];
    readonly guestSecurityDenials: readonly string[];
  };
  readonly processErrors: readonly string[];
  readonly activeGuestId: number | null;
  readonly activeDescriptor: {
    readonly partition: string;
    readonly src: string;
    readonly sandboxId: string;
    readonly initId: string;
    readonly generation: number;
  } | null;
};

type FixtureDescriptor = NonNullable<FixtureState["activeDescriptor"]>;

const KNOWN_GUEST_SANDBOX_WARNING =
  /^A sandboxed iframe with the 'allow-scripts' and 'allow-same-origin' attributes can remove its sandboxing\.?$/u;
const KNOWN_GUEST_SECURITY_DENIAL =
  /blocked\.invalid|blocked_by_csp|content security policy|refused to connect|not allowed to navigate|download|permission|popup|network/iu;

function assertGuestDiagnostics(
  diagnostics: FixtureState["diagnostics"],
  requireSecurityDenial: boolean,
): void {
  expect(diagnostics.preloadErrors).toEqual([]);
  expect(diagnostics.guestConsoleErrors).toEqual([]);
  expect(
    diagnostics.guestConsoleWarnings.filter(
      (message) => !KNOWN_GUEST_SANDBOX_WARNING.test(message),
    ),
  ).toEqual([]);
  if (requireSecurityDenial) {
    const securityDenials = [
      ...diagnostics.guestConsoleSecurityDenials,
      ...diagnostics.guestSecurityDenials,
    ];
    expect(securityDenials.length, JSON.stringify(diagnostics)).toBeGreaterThan(0);
    expect(securityDenials.filter((message) => !KNOWN_GUEST_SECURITY_DENIAL.test(message))).toEqual(
      [],
    );
  } else {
    expect(diagnostics.guestConsoleSecurityDenials).toEqual([]);
    expect(diagnostics.guestSecurityDenials).toEqual([]);
  }
}

const SECURITY_PROBE_SCRIPT = `(async () => {
  const frame = document.querySelector("#mcp-app-frame");
  const guest = frame?.contentWindow;
  const guestDocument = frame?.contentDocument;
  const result = { popup: false, egress: false, permissionApiAvailable: false, denied: false };
  if (!guest || !guestDocument) return result;
  try { result.popup = guest.open("https://blocked.invalid/popup", "_blank") === null; } catch { result.popup = true; }
  try { const response = await guest.fetch("https://blocked.invalid/egress"); result.egress = !response.ok; } catch { result.egress = true; }
  try {
    const getUserMedia = guest.navigator.mediaDevices?.getUserMedia;
    result.permissionApiAvailable = typeof getUserMedia === "function";
    if (result.permissionApiAvailable) {
      await getUserMedia.call(guest.navigator.mediaDevices, { audio: true });
      result.denied = false;
    }
  } catch { result.denied = true; }
  const link = guestDocument.createElement("a");
  link.href = "https://blocked.invalid/mcp-app-download.txt";
  link.download = "mcp-app-download.txt";
  guestDocument.body.append(link);
  link.click();
  const blockedScript = guestDocument.createElement("script");
  blockedScript.src = "https://blocked.invalid/mcp-app-script.js";
  guestDocument.body.append(blockedScript);
  await new Promise((resolve) => setTimeout(resolve, 100));
  return result;
})()`;

type ElectronFixture = {
  readonly application: ElectronApplication;
  readonly page: Page;
  readonly consoleErrors: string[];
  readonly consoleSecurityDenials: string[];
  readonly pageErrors: string[];
  readonly stderr: string[];
};

async function launchFixture(home: string): Promise<ElectronFixture> {
  const mainPath = process.env.MOSS_E2E_MCP_APP_MAIN;
  if (!mainPath) throw new Error("MCP App sandbox Electron main bundle was not prepared.");
  const executablePath = requireFromDesktop("electron") as string;
  const application = await electron.launch({
    executablePath,
    args: [mainPath],
    cwd: DESKTOP_DIR,
    env: {
      ...process.env,
      HOME: home,
      MOSS_HOME: home,
    },
  });
  const page = await application.firstWindow();
  const consoleErrors: string[] = [];
  const consoleSecurityDenials: string[] = [];
  const pageErrors: string[] = [];
  const stderr: string[] = [];
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    if (/failed to load resource[\s\S]*404|content security policy/iu.test(message.text())) {
      consoleSecurityDenials.push(message.text());
    } else {
      consoleErrors.push(message.text());
    }
  });
  page.on("pageerror", (error) => pageErrors.push(error.message));
  application.process().stderr?.on("data", (chunk: Buffer) => stderr.push(chunk.toString("utf8")));
  try {
    await expect(page.locator("#fixture-host")).toHaveAttribute("data-phase", "ready", {
      timeout: 20_000,
    });
  } catch (error) {
    let mainState = "unavailable";
    let rendererState = "unavailable";
    try {
      mainState = JSON.stringify(
        await application.evaluate((_electron) => {
          const state = (
            globalThis as typeof globalThis & {
              __mossMcpAppE2E: { state: () => unknown };
            }
          ).__mossMcpAppE2E;
          return state.state();
        }),
      );
    } catch {
      // The main process may already be exiting.
    }
    try {
      rendererState = JSON.stringify(
        await page.evaluate(() => {
          const webview = document.querySelector("webview") as
            | (HTMLElement & { getURL?: () => string })
            | null;
          return { src: webview?.getAttribute("src") ?? null, url: webview?.getURL?.() ?? null };
        }),
      );
    } catch {
      // The renderer may have already torn down the element.
    }
    throw new Error(
      `MCP App fixture did not load (${page.url()}): ${String(error)}; main=${mainState}; renderer=${rendererState}; console=${consoleErrors.join(" | ")}; page=${pageErrors.join(" | ")}; stderr=${stderr.join("")}`,
    );
  }
  return { application, page, consoleErrors, consoleSecurityDenials, pageErrors, stderr };
}

async function closeFixture(fixture: ElectronFixture): Promise<void> {
  await fixture.application.close();
}

function fixtureState(application: ElectronApplication): Promise<FixtureState> {
  return application.evaluate((_electron) => {
    const state = (
      globalThis as typeof globalThis & {
        __mossMcpAppE2E: { state: () => FixtureState };
      }
    ).__mossMcpAppE2E;
    return state.state();
  });
}

function fixtureGuest(application: ElectronApplication, script: string): Promise<unknown> {
  return application.evaluate(async (_electron, input) => {
    const state = (
      globalThis as typeof globalThis & {
        __mossMcpAppE2E: { executeActiveGuest: (value: string) => Promise<unknown> };
      }
    ).__mossMcpAppE2E;
    return state.executeActiveGuest(input);
  }, script);
}

function rendererDescriptor(page: Page): Promise<FixtureDescriptor> {
  return page.evaluate(() => {
    const fixture = (
      window as typeof window & {
        __mossMcpAppFixture: { getDescriptor: () => FixtureDescriptor | null };
      }
    ).__mossMcpAppFixture;
    const descriptor = fixture.getDescriptor();
    if (!descriptor) throw new Error("MCP App renderer descriptor was not available.");
    return descriptor;
  });
}

function rendererGuestState(application: ElectronApplication): Promise<Record<string, string>> {
  return fixtureGuest(
    application,
    `(() => {
      const frame = document.querySelector("#mcp-app-frame");
      const body = frame?.contentDocument?.body;
      return body ? Object.fromEntries(Object.entries(body.dataset)) : {};
    })()`,
  ) as Promise<Record<string, string>>;
}

type GuestFrameGeometry = {
  readonly outerViewportHeight: number;
  readonly outerDocumentClientHeight: number;
  readonly iframeRectHeight: number;
  readonly iframeClientHeight: number;
  readonly innerViewportHeight: number;
  readonly innerDocumentClientHeight: number;
};

function rendererGuestFrameGeometry(application: ElectronApplication): Promise<GuestFrameGeometry> {
  return fixtureGuest(
    application,
    `(() => {
      const frame = document.querySelector("#mcp-app-frame");
      const rect = frame?.getBoundingClientRect();
      const innerDocument = frame?.contentDocument?.documentElement;
      return {
        outerViewportHeight: window.innerHeight,
        outerDocumentClientHeight: document.documentElement.clientHeight,
        iframeRectHeight: rect?.height ?? -1,
        iframeClientHeight: frame?.clientHeight ?? -1,
        innerViewportHeight: frame?.contentWindow?.innerHeight ?? -1,
        innerDocumentClientHeight: innerDocument?.clientHeight ?? -1,
      };
    })()`,
  ) as Promise<GuestFrameGeometry>;
}

function expectGuestFrameToFillViewport(geometry: GuestFrameGeometry): void {
  const heights = [
    geometry.outerViewportHeight,
    geometry.outerDocumentClientHeight,
    geometry.iframeRectHeight,
    geometry.iframeClientHeight,
    geometry.innerViewportHeight,
    geometry.innerDocumentClientHeight,
  ];
  expect(heights.every((height) => height >= 0)).toBe(true);
  const reference = geometry.outerViewportHeight;
  for (const height of heights) {
    expect(Math.abs(height - reference), JSON.stringify(geometry)).toBeLessThanOrEqual(1);
  }
}

async function screenshot(page: Page, path: string): Promise<void> {
  const pixels = await page.screenshot({ path, animations: "disabled" });
  expect(pixels.byteLength).toBeGreaterThan(0);
  expect(existsSync(path)).toBe(true);
  expect(statSync(path).size).toBeGreaterThan(0);
}

test("fullscreen handshake returns before the deferred production dock layout", async () => {
  // Cold Electron first-launch dominates the budget here; the handshake-speed
  // contract is the <2s assertion measured after launch, not this outer bound.
  test.setTimeout(90_000);
  const home = join("/tmp", `moss-mcp-app-handshake-${crypto.randomUUID()}`);
  mkdirSync(home, { recursive: true });
  let fixture: ElectronFixture | null = null;
  try {
    fixture = await launchFixture(home);
    const before = await fixtureState(fixture.application);
    const startedAt = Date.now();
    const receipt = await fixtureGuest(
      fixture.application,
      `(async () => {
        const app = document.querySelector("#mcp-app-frame")?.contentWindow?.__mossMcpApp;
        if (!app) throw new Error("MCP App fixture API is missing");
        return await Promise.race([
          app.requestDisplayMode({ mode: "fullscreen" }).then((value) => ({ kind: "receipt", value })),
          new Promise((resolve) => setTimeout(() => resolve({ kind: "timeout" }), 4_000)),
        ]);
      })()`,
    );
    const afterHandshake = await fixtureState(fixture.application);
    expect(
      receipt,
      JSON.stringify({
        fixture: afterHandshake,
        rightDock: await fixture.page.locator('[data-testid="right-dock-panel"]').count(),
        sideHost: await fixture.page
          .locator('[data-mcp-app-side-panel-frame-container="true"]')
          .count(),
      }),
    ).toEqual({ kind: "receipt", value: { mode: "fullscreen" } });
    expect(Date.now() - startedAt).toBeLessThan(2_000);
    const movedState = await fixtureState(fixture.application);
    expect(movedState, JSON.stringify(movedState)).toMatchObject({
      activeGuests: before.activeGuests,
      activeGuestId: before.activeGuestId,
      registerCount: before.registerCount,
    });
    expect(movedState.diagnostics.willAttach).toBe(1);
    expect(await fixture.page.locator('[data-mcp-app-portal-target="true"]').count()).toBe(1);
    const stablePlacement = await fixture.page.evaluate(() => {
      const wrapper = document.querySelector<HTMLElement>('[data-mcp-app-frame-wrapper="true"]');
      const portal = document.querySelector<HTMLElement>('[data-mcp-app-portal-target="true"]');
      return {
        wrapperParentIsPortal: wrapper?.parentElement === portal,
        wrapperPosition: wrapper ? getComputedStyle(wrapper).position : "",
      };
    });
    expect(stablePlacement).toEqual({ wrapperParentIsPortal: true, wrapperPosition: "fixed" });
    await expect(fixture.page.locator('[data-testid="right-dock-panel"]')).toBeVisible({
      timeout: 5_000,
    });
    await expect(
      fixture.page.locator('[data-mcp-app-side-panel-frame-container="true"]'),
    ).toHaveCount(1);
  } finally {
    if (fixture) await closeFixture(fixture).catch(() => undefined);
    rmSync(home, { recursive: true, force: true });
  }
});

test("production MCP App sandbox initializes, isolates, cleans up, and survives restart checks", async () => {
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  const home = join("/tmp", `moss-mcp-app-e2e-${crypto.randomUUID()}`);
  mkdirSync(home, { recursive: true });
  let first: ElectronFixture | null = null;
  let second: ElectronFixture | null = null;
  try {
    first = await launchFixture(home);
    const firstDescriptor = await rendererDescriptor(first.page);
    expect(firstDescriptor.partition.startsWith("persist:")).toBe(false);
    expect(firstDescriptor.partition).toBe(`moss-mcp-${firstDescriptor.sandboxId}`);
    expect(firstDescriptor.src).toMatch(/^moss-mcp-sandbox:\/\/[^/]+\/ui\?generation=0#init=/u);
    const baselineWindowUrls = first.application.windows().map((window) => window.url());

    let state = await fixtureState(first.application);
    expect(state.activeGuests).toBe(1);
    expect(state.pendingAttach).toBe(0);
    expect(state.registeredPartitions).toBe(1);
    expect(state.partitionPolicies).toBe(1);
    expect(state.diagnostics.configuredGuestPreloadPath).toBe("mcpAppSandboxGuestPreload.cjs");
    expect(state.diagnostics.configuredAnnotationPreloadPath).toBe(
      "browserAnnotationGuestPreload.cjs",
    );
    expect(state.diagnostics.rendererCssInjected).toBe(true);
    expect(
      await first.page.evaluate(
        () =>
          document.querySelector<HTMLLinkElement>('link[href="/mcpAppSandbox.css"]')?.sheet !==
          null,
      ),
    ).toBe(true);
    expect(state.diagnostics.runtimeGuestPreloadPaths).toEqual(["mcpAppSandboxGuestPreload.cjs"]);
    expect(state.diagnostics.willAttachPreferences.at(-1)).toMatchObject({
      preload: "mcpAppSandboxGuestPreload.cjs",
      sandbox: true,
    });
    expect(state.diagnostics.didAttachSessionMatches).toEqual([true]);
    assertGuestDiagnostics(state.diagnostics, false);

    let guestState = await rendererGuestState(first.application);
    expect(guestState.connected).toBe("true");
    expect(guestState.hostPlatform).toBe("desktop");
    expect(guestState.hostDisplayMode).toBe("inline");
    expect(guestState.storageBefore).toBe("absent");
    expect(guestState.toolInput).toContain("fixture-input");
    expect(guestState.toolResult).toContain("fixture-result");
    expect(guestState.toolResult).not.toContain("must-not-leak");
    expect(guestState.theme).toBe("light");
    expect(guestState.containerWidth).toBeTruthy();
    expect(guestState.containerHeight).toBeTruthy();
    expect(JSON.parse(guestState.lastHostContext ?? "{}")).toMatchObject({
      displayMode: "inline",
      availableDisplayModes: ["inline", "fullscreen"],
      safeAreaInsets: { top: 0, right: 0, bottom: 0, left: 0 },
    });
    expectGuestFrameToFillViewport(await rendererGuestFrameGeometry(first.application));
    const inlinePlacement = await first.page.evaluate(() => {
      const wrapper = document.querySelector<HTMLElement>('[data-mcp-app-frame-wrapper="true"]');
      const portal = document.querySelector<HTMLElement>('[data-mcp-app-portal-target="true"]');
      const target = document.querySelector<HTMLElement>('[data-mcp-app-frame="true"]');
      const wrapperRect = wrapper?.getBoundingClientRect();
      const targetRect = target?.getBoundingClientRect();
      return {
        wrapperParentIsPortal: wrapper?.parentElement === portal,
        wrapperPosition: wrapper ? getComputedStyle(wrapper).position : "",
        wrapperZIndex: wrapper ? getComputedStyle(wrapper).zIndex : "",
        wrapperRect: wrapperRect
          ? {
              left: wrapperRect.left,
              top: wrapperRect.top,
              width: wrapperRect.width,
              height: wrapperRect.height,
            }
          : null,
        targetRect: targetRect
          ? {
              left: targetRect.left,
              top: targetRect.top,
              width: targetRect.width,
              height: targetRect.height,
            }
          : null,
      };
    });
    expect(inlinePlacement.wrapperParentIsPortal).toBe(true);
    expect(inlinePlacement.wrapperPosition).toBe("absolute");
    expect(inlinePlacement.wrapperZIndex).toBe("1");
    expect(inlinePlacement.wrapperRect).not.toBeNull();
    expect(inlinePlacement.targetRect).not.toBeNull();
    for (const key of ["left", "top", "width", "height"] as const) {
      expect(
        Math.abs(inlinePlacement.wrapperRect![key] - inlinePlacement.targetRect![key]),
        JSON.stringify(inlinePlacement),
      ).toBeLessThanOrEqual(1);
    }
    expect(
      await first.page
        .locator('[data-fixture-production-component="TimelineWorkEntryRow"]')
        .count(),
    ).toBe(1);
    expect(
      await first.page.locator('[data-mcp-app-card="true"] [data-mcp-app-frame="true"]').count(),
    ).toBe(1);
    expect(await first.page.locator('[data-tool-detail-header="true"]').count()).toBe(1);
    expect(
      await first.page.locator('[data-automatic-approval-review="fixture-review"]').count(),
    ).toBe(1);
    expect(await first.page.locator('[data-mcp-invocation="true"]').count()).toBe(0);
    const headerText = await first.page.locator('[data-tool-detail-header="true"]').innerText();
    expect(headerText).toContain("render_widget");
    expect(headerText).not.toContain("MCP App");
    expect(
      await first.page.evaluate(() => {
        const review = document.querySelector('[data-automatic-approval-review="fixture-review"]');
        const frame = document.querySelector('[data-mcp-app-frame="true"]');
        return Boolean(
          review &&
          frame &&
          review.compareDocumentPosition(frame) & Node.DOCUMENT_POSITION_FOLLOWING,
        );
      }),
    ).toBe(true);
    const appFrame = first.page.locator('[data-mcp-app-frame="true"]');
    await expect(appFrame).toHaveAttribute("data-mcp-app-ready", "true");
    const guestElement = first.page.locator('webview[data-mcp-app-sandbox="true"]');
    expect(await guestElement.evaluate((element) => getComputedStyle(element).display)).toBe(
      "block",
    );
    const rawAction = first.page.locator('[data-mcp-raw-action="true"]');
    await rawAction.focus();
    await first.page.keyboard.press("Enter");
    await expect(first.page.locator('[data-mcp-raw-dialog="true"]')).toBeVisible();
    await first.page.keyboard.press("Escape");
    await expect(first.page.locator('[data-mcp-raw-dialog="true"]')).toHaveCount(0);
    await first.page.locator("#fixture-host").focus();
    const isolation = (await fixtureGuest(
      first.application,
      `(() => {
        const frame = document.querySelector("#mcp-app-frame");
        const inner = frame?.contentWindow;
        return {
          outerDesktopBridge: "desktopBridge" in window,
          outerNode: typeof process !== "undefined",
          innerDesktopBridge: inner ? "desktopBridge" in inner : true,
          innerNode: inner ? typeof inner.process !== "undefined" : true,
          sandbox: frame?.getAttribute("sandbox") ?? null,
        };
      })()`,
    )) as {
      outerDesktopBridge: boolean;
      outerNode: boolean;
      innerDesktopBridge: boolean;
      innerNode: boolean;
      sandbox: string | null;
    };
    expect(isolation).toEqual({
      outerDesktopBridge: false,
      outerNode: false,
      innerDesktopBridge: false,
      innerNode: false,
      sandbox: "allow-scripts allow-same-origin allow-forms",
    });

    await screenshot(first.page, resolve(EVIDENCE_DIR, "HEL-46-mcp-app-sandbox-light-desktop.png"));
    expect(await first.page.locator('[data-mcp-app-navigation-controls="true"]').count()).toBe(0);

    const guestIdBeforeFullscreen = (await fixtureState(first.application)).activeGuestId;
    const lifecycleBeforeFullscreen = (await fixtureState(first.application)).diagnostics
      .guestLifecycle.length;
    const messageCountBeforeNavigation = (await fixtureState(first.application)).diagnostics
      .guestMessage;
    const pushedRoute = await fixtureGuest(
      first.application,
      `(() => {
        const app = document.querySelector("#mcp-app-frame")?.contentWindow?.__mossMcpApp;
        if (!app?.pushFixtureRoute) throw new Error("MCP App fixture route API is missing");
        return app.pushFixtureRoute();
      })()`,
    );
    expect(new URL(String(pushedRoute)).pathname).toBe("/mcp-app-route-two");
    await expect(first.page.locator('[data-mcp-app-navigation-controls="true"]')).toHaveCount(1);
    const inlineNavigationControls = first.page.locator(
      '[data-mcp-app-navigation-portal="true"] [data-mcp-app-navigation-controls="true"]',
    );
    await expect(inlineNavigationControls).toHaveCount(1);
    const backButton = inlineNavigationControls.getByRole("button", {
      name: "Back",
      exact: true,
    });
    const nextButton = inlineNavigationControls.getByRole("button", {
      name: "Next",
      exact: true,
    });
    await expect(backButton).toBeEnabled();
    await expect(nextButton).toBeDisabled();
    await expect
      .poll(async () => {
        const current = await rendererGuestState(first!.application);
        return JSON.parse(current.lastHostContext ?? "{}").safeAreaInsets?.top ?? null;
      })
      .toBe(48);
    const inlineNavigationPaint = await first.page.evaluate(() => {
      const controls = document.querySelector<HTMLElement>(
        '[data-mcp-app-navigation-portal="true"] [data-mcp-app-navigation-controls="true"]',
      );
      const webview = document.querySelector<HTMLElement>('webview[data-mcp-app-sandbox="true"]');
      const controlsRect = controls?.getBoundingClientRect();
      const webviewRect = webview?.getBoundingClientRect();
      return {
        controlsRect: controlsRect
          ? {
              left: controlsRect.left,
              top: controlsRect.top,
              right: controlsRect.right,
              bottom: controlsRect.bottom,
            }
          : null,
        webviewRect: webviewRect
          ? {
              left: webviewRect.left,
              top: webviewRect.top,
              right: webviewRect.right,
              bottom: webviewRect.bottom,
            }
          : null,
      };
    });
    const inlineAppContent = (await fixtureGuest(
      first.application,
      `(() => {
        const frame = document.querySelector("#mcp-app-frame");
        const innerDocument = frame?.contentDocument;
        const shell = innerDocument?.querySelector("#app-shell");
        const content = innerDocument?.querySelector("#app-content");
        const rect = content?.getBoundingClientRect();
        return {
          safeAreaTop: shell?.dataset.safeAreaTop ?? null,
          rect: rect
            ? { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom }
            : null,
        };
      })()`,
    )) as {
      readonly safeAreaTop: string | null;
      readonly rect: {
        readonly left: number;
        readonly top: number;
        readonly right: number;
        readonly bottom: number;
      } | null;
    };
    expect(inlineAppContent.safeAreaTop, JSON.stringify(inlineAppContent)).toBe("48px");
    const contentRect =
      inlineNavigationPaint.webviewRect && inlineAppContent.rect
        ? {
            left: inlineNavigationPaint.webviewRect.left + inlineAppContent.rect.left,
            top: inlineNavigationPaint.webviewRect.top + inlineAppContent.rect.top,
            right: inlineNavigationPaint.webviewRect.left + inlineAppContent.rect.right,
            bottom: inlineNavigationPaint.webviewRect.top + inlineAppContent.rect.bottom,
          }
        : null;
    const controlsRect = inlineNavigationPaint.controlsRect;
    const overlapsContent =
      controlsRect !== null &&
      contentRect !== null &&
      controlsRect.left < contentRect.right &&
      contentRect.left < controlsRect.right &&
      controlsRect.top < contentRect.bottom &&
      contentRect.top < controlsRect.bottom;
    expect(
      overlapsContent,
      JSON.stringify({ inlineNavigationPaint, inlineAppContent, contentRect }),
    ).toBe(false);
    const afterPush = (await fixtureGuest(
      first.application,
      `(() => {
        const frame = document.querySelector("#mcp-app-frame");
        return {
          outer: location.href,
          inner: frame?.contentWindow?.location.href ?? null,
        };
      })()`,
    )) as { outer: string; inner: string | null };
    expect(afterPush.outer).toBe(firstDescriptor.src);
    expect(afterPush.inner).toContain("/mcp-app-route-two");
    expect(await rendererDescriptor(first.page)).toEqual(firstDescriptor);
    let navigationState = await fixtureState(first.application);
    expect(navigationState.activeGuestId).toBe(guestIdBeforeFullscreen);
    expect(navigationState.registerCount).toBe(1);
    expect(navigationState.diagnostics.guestLifecycle.length).toBe(lifecycleBeforeFullscreen);
    expect(navigationState.diagnostics.guestMessage).toBe(messageCountBeforeNavigation);
    guestState = await rendererGuestState(first.application);
    expect(guestState.connected).toBe("true");
    expect(guestState.storageBefore).toBe("absent");
    expect(guestState.toolInput).toContain("fixture-input");
    expect(guestState.toolResult).toContain("fixture-result");
    expect(guestState.route).toContain("/mcp-app-route-two");

    await backButton.click();
    await expect
      .poll(async () => (await rendererGuestState(first!.application)).route ?? "")
      .toContain("/content?");
    await expect(backButton).toBeDisabled();
    await expect(nextButton).toBeEnabled();
    expect(
      JSON.parse((await rendererGuestState(first.application)).lastHostContext ?? "{}")
        .safeAreaInsets,
    ).toEqual({ top: 48, right: 0, bottom: 0, left: 0 });
    expect(await rendererDescriptor(first.page)).toEqual(firstDescriptor);
    navigationState = await fixtureState(first.application);
    expect(navigationState.activeGuestId).toBe(guestIdBeforeFullscreen);
    expect(navigationState.registerCount).toBe(1);
    expect(navigationState.diagnostics.guestLifecycle.length).toBe(lifecycleBeforeFullscreen);
    expect(navigationState.diagnostics.guestMessage).toBe(messageCountBeforeNavigation);

    await nextButton.click();
    await expect
      .poll(async () => (await rendererGuestState(first!.application)).route ?? "")
      .toContain("/mcp-app-route-two");
    await expect(backButton).toBeEnabled();
    await expect(nextButton).toBeDisabled();
    expect(await rendererDescriptor(first.page)).toEqual(firstDescriptor);
    navigationState = await fixtureState(first.application);
    expect(navigationState.activeGuestId).toBe(guestIdBeforeFullscreen);
    expect(navigationState.registerCount).toBe(1);
    expect(navigationState.diagnostics.guestLifecycle.length).toBe(lifecycleBeforeFullscreen);
    expect(navigationState.diagnostics.guestMessage).toBe(messageCountBeforeNavigation);
    await screenshot(
      first.page,
      resolve(EVIDENCE_DIR, "HEL-46-mcp-app-inline-history-light-desktop.png"),
    );

    const fullscreenReceipt = await fixtureGuest(
      first.application,
      `(async () => {
        const app = document.querySelector("#mcp-app-frame")?.contentWindow?.__mossMcpApp;
        if (!app) throw new Error("MCP App fixture API is missing");
        return await app.requestDisplayMode({ mode: "fullscreen" });
      })()`,
    );
    expect(fullscreenReceipt).toEqual({ mode: "fullscreen" });
    await expect(first.page.locator('[data-testid="right-dock-panel"]')).toBeVisible();
    await expect(
      first.page.locator('[data-mcp-app-side-panel-frame-container="true"]'),
    ).toHaveCount(1);
    await expect(first.page.locator('[data-mcp-app-display-mode="fullscreen"]')).toHaveCount(1);
    expect(await first.page.locator('[data-mcp-app-frame-wrapper="true"]').count()).toBe(1);
    expect(await first.page.locator('webview[data-mcp-app-sandbox="true"]').count()).toBe(1);
    expect(await first.page.locator("[data-mcp-app-dock-entry]").count()).toBe(1);
    await expect(
      first.page.locator(
        '[data-mcp-app-navigation-portal="true"] [data-mcp-app-navigation-controls="true"]',
      ),
    ).toHaveCount(0);
    const fullscreenNavigationControls = first.page.locator(
      '[data-right-dock-content] [data-mcp-app-navigation-controls="true"]',
    );
    await expect(fullscreenNavigationControls).toHaveCount(1);
    await expect(
      fullscreenNavigationControls.getByRole("button", { name: "Back", exact: true }),
    ).toBeEnabled();
    await expect(
      fullscreenNavigationControls.getByRole("button", { name: "Next", exact: true }),
    ).toBeDisabled();
    await screenshot(
      first.page,
      resolve(EVIDENCE_DIR, "HEL-46-mcp-app-fullscreen-history-light-desktop.png"),
    );
    const fullscreenPlacement = await first.page.evaluate(() => {
      const wrapper = document.querySelector<HTMLElement>('[data-mcp-app-frame-wrapper="true"]');
      const portal = document.querySelector<HTMLElement>('[data-mcp-app-portal-target="true"]');
      const sideHost = document.querySelector<HTMLElement>(
        '[data-mcp-app-side-panel-frame-container="true"]',
      );
      const inlineHost = document.querySelector<HTMLElement>('[data-mcp-app-frame="true"]');
      const wrapperRect = wrapper?.getBoundingClientRect();
      const sideRect = sideHost?.getBoundingClientRect();
      return {
        wrapperParentIsPortal: wrapper?.parentElement === portal,
        wrapperPosition: wrapper ? getComputedStyle(wrapper).position : "",
        wrapperZIndex: wrapper ? getComputedStyle(wrapper).zIndex : "",
        wrapperRect: wrapperRect
          ? {
              left: wrapperRect.left,
              top: wrapperRect.top,
              width: wrapperRect.width,
              height: wrapperRect.height,
            }
          : null,
        sideRect: sideRect
          ? {
              left: sideRect.left,
              top: sideRect.top,
              width: sideRect.width,
              height: sideRect.height,
            }
          : null,
        inlineHostChildren: inlineHost?.children.length ?? -1,
      };
    });
    expect(fullscreenPlacement.wrapperParentIsPortal).toBe(true);
    expect(fullscreenPlacement.wrapperPosition).toBe("fixed");
    expect(fullscreenPlacement.wrapperZIndex).toBe("43");
    expect(fullscreenPlacement.inlineHostChildren).toBe(0);
    expect(fullscreenPlacement.wrapperRect).not.toBeNull();
    expect(fullscreenPlacement.sideRect).not.toBeNull();
    for (const key of ["left", "top", "width", "height"] as const) {
      expect(
        Math.abs(fullscreenPlacement.wrapperRect![key] - fullscreenPlacement.sideRect![key]),
        JSON.stringify(fullscreenPlacement),
      ).toBeLessThanOrEqual(1);
    }
    let fullscreenState = await fixtureState(first.application);
    expect(fullscreenState.activeGuestId, JSON.stringify(fullscreenState)).toBe(
      guestIdBeforeFullscreen,
    );
    expect(fullscreenState.registerCount).toBe(1);
    expect(fullscreenState.diagnostics.guestLifecycle.length).toBe(lifecycleBeforeFullscreen);
    expect(fullscreenState.diagnostics.willAttach).toBe(1);
    expect((await rendererGuestState(first.application)).hostDisplayMode).toBe("fullscreen");
    expect(
      JSON.parse((await rendererGuestState(first.application)).lastHostContext ?? "{}"),
    ).toMatchObject({
      displayMode: "fullscreen",
      availableDisplayModes: ["inline", "fullscreen"],
      safeAreaInsets: { top: 0, right: 0, bottom: 0, left: 0 },
    });
    expect(
      await fixtureGuest(
        first.application,
        `(() => {
          const frame = document.querySelector("#mcp-app-frame");
          return frame?.contentDocument?.querySelector("#app-shell")?.dataset.safeAreaTop ?? null;
        })()`,
      ),
    ).toBe("0px");

    await first.page.evaluate(() => {
      const fixture = (
        window as typeof window & {
          __mossMcpAppFixture: { setDockOpen(open: boolean): void };
        }
      ).__mossMcpAppFixture;
      fixture.setDockOpen(false);
    });
    await expect
      .poll(() =>
        first.page.locator('[data-mcp-app-frame-wrapper="true"]').evaluate((element) => ({
          display: getComputedStyle(element).display,
          visibility: getComputedStyle(element).visibility,
          pointerEvents: getComputedStyle(element).pointerEvents,
        })),
      )
      .toEqual({ display: "none", visibility: "hidden", pointerEvents: "none" });
    await first.page.evaluate(() => {
      const fixture = (
        window as typeof window & {
          __mossMcpAppFixture: { setDockOpen(open: boolean): void };
        }
      ).__mossMcpAppFixture;
      fixture.setDockOpen(true);
    });
    await expect
      .poll(() =>
        first.page.locator('[data-mcp-app-frame-wrapper="true"]').evaluate((element) => ({
          display: getComputedStyle(element).display,
          visibility: getComputedStyle(element).visibility,
          pointerEvents: getComputedStyle(element).pointerEvents,
        })),
      )
      .toEqual({ display: "block", visibility: "visible", pointerEvents: "auto" });

    // The same MCP App pane stays mounted while a separate dock tab is active.
    await first.page.getByRole("button", { name: "Other", exact: true }).click();
    await expect(first.page.locator('[data-fixture-other-pane="true"]')).toBeVisible();
    await expect(first.page.locator('[data-mcp-app-navigation-controls="true"]')).toHaveCount(0);
    await expect
      .poll(() =>
        first.page.locator('[data-mcp-app-frame-wrapper="true"]').evaluate((element) => {
          const style = getComputedStyle(element);
          const rect = element.getBoundingClientRect();
          return {
            display: style.display,
            visibility: style.visibility,
            pointerEvents: style.pointerEvents,
            width: rect.width,
          };
        }),
      )
      .toEqual({ display: "none", visibility: "hidden", pointerEvents: "none", width: 0 });
    const otherPaneHit = await first.page.evaluate(() => {
      const other = document.querySelector<HTMLElement>('[data-fixture-other-pane="true"]');
      const rect = other?.getBoundingClientRect();
      const hit = rect
        ? document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)
        : null;
      return {
        otherVisible: Boolean(other && rect && rect.width > 0 && rect.height > 0),
        hitInsideOther: Boolean(hit?.closest('[data-fixture-other-pane="true"]')),
      };
    });
    expect(otherPaneHit).toEqual({ otherVisible: true, hitInsideOther: true });
    await first.page.evaluate(() => window.dispatchEvent(new Event("resize")));
    await first.page.waitForTimeout(50);
    await expect(first.page.locator('[data-mcp-app-frame-wrapper="true"]')).toHaveCSS(
      "display",
      "none",
    );
    expect(await first.page.locator('[data-mcp-app-frame-wrapper="true"]').count()).toBe(1);
    expect((await fixtureState(first.application)).activeGuestId).toBe(guestIdBeforeFullscreen);
    expect((await fixtureState(first.application)).diagnostics.guestLifecycle.length).toBe(
      lifecycleBeforeFullscreen,
    );
    await first.page.getByRole("button", { name: "Moss MCP App fixture", exact: true }).click();
    await expect(
      first.page.locator('[data-mcp-app-side-panel-frame-container="true"]'),
    ).toHaveCount(1);
    await expect(
      first.page.locator('[data-right-dock-content] [data-mcp-app-navigation-controls="true"]'),
    ).toHaveCount(1);
    await expect
      .poll(() =>
        first.page.locator('[data-mcp-app-frame-wrapper="true"]').evaluate((element) => {
          const style = getComputedStyle(element);
          return { display: style.display, visibility: style.visibility };
        }),
      )
      .toEqual({ display: "block", visibility: "visible" });
    // The wrapper tracks the dock's side-panel anchor exactly (the old
    // assertion pinned the pre-rework dock's fixed width).
    const reselectedPlacement = await first.page.evaluate(() => {
      const wrapper = document.querySelector<HTMLElement>('[data-mcp-app-frame-wrapper="true"]');
      const sideHost = document.querySelector<HTMLElement>(
        '[data-mcp-app-side-panel-frame-container="true"]',
      );
      const wrapperRect = wrapper?.getBoundingClientRect();
      const sideRect = sideHost?.getBoundingClientRect();
      return {
        wrapperRect: wrapperRect
          ? {
              left: wrapperRect.left,
              top: wrapperRect.top,
              width: wrapperRect.width,
              height: wrapperRect.height,
            }
          : null,
        sideRect: sideRect
          ? {
              left: sideRect.left,
              top: sideRect.top,
              width: sideRect.width,
              height: sideRect.height,
            }
          : null,
      };
    });
    expect(reselectedPlacement.wrapperRect).not.toBeNull();
    expect(reselectedPlacement.sideRect).not.toBeNull();
    expect(reselectedPlacement.wrapperRect!.width).toBeGreaterThan(0);
    for (const key of ["left", "top", "width", "height"] as const) {
      expect(
        Math.abs(reselectedPlacement.wrapperRect![key] - reselectedPlacement.sideRect![key]),
        JSON.stringify(reselectedPlacement),
      ).toBeLessThanOrEqual(1);
    }

    const inlineReceipt = await fixtureGuest(
      first.application,
      `(async () => await document.querySelector("#mcp-app-frame")?.contentWindow?.__mossMcpApp?.requestDisplayMode({ mode: "inline" }))()`,
    );
    expect(inlineReceipt).toEqual({ mode: "inline" });
    await expect(first.page.locator('[data-mcp-app-display-mode="inline"]')).toHaveCount(1);
    await expect(
      first.page.locator('[data-mcp-app-side-panel-frame-container="true"]'),
    ).toHaveCount(0);
    await expect(
      first.page.locator(
        '[data-mcp-app-navigation-portal="true"] [data-mcp-app-navigation-controls="true"]',
      ),
    ).toHaveCount(1);
    await expect(
      first.page.locator('[data-right-dock-content] [data-mcp-app-navigation-controls="true"]'),
    ).toHaveCount(0);
    expect(await first.page.locator('webview[data-mcp-app-sandbox="true"]').count()).toBe(1);
    expect((await rendererGuestState(first.application)).hostDisplayMode).toBe("inline");
    fullscreenState = await fixtureState(first.application);
    expect(fullscreenState.activeGuestId).toBe(guestIdBeforeFullscreen);
    expect(fullscreenState.registerCount).toBe(1);
    expect(fullscreenState.diagnostics.guestLifecycle.length).toBe(lifecycleBeforeFullscreen);

    // Re-enter fullscreen, then close only the transient App tab. The other
    // tab remains and the live guest returns to the inline host.
    const secondFullscreenReceipt = await fixtureGuest(
      first.application,
      `(async () => await document.querySelector("#mcp-app-frame")?.contentWindow?.__mossMcpApp?.requestDisplayMode({ mode: "fullscreen" }))()`,
    );
    expect(secondFullscreenReceipt).toEqual({ mode: "fullscreen" });
    await expect(
      first.page.locator('[data-mcp-app-side-panel-frame-container="true"]'),
    ).toHaveCount(1);
    await screenshot(
      first.page,
      resolve(EVIDENCE_DIR, "HEL-46-mcp-app-fullscreen-light-desktop.png"),
    );
    const lightFullscreenPaint = await first.page.evaluate(() => {
      const wrapper = document.querySelector<HTMLElement>('[data-mcp-app-frame-wrapper="true"]');
      const webview = document.querySelector<HTMLElement>('webview[data-mcp-app-sandbox="true"]');
      const rect = wrapper?.getBoundingClientRect();
      const webviewRect = webview?.getBoundingClientRect();
      const sideHost = document.querySelector<HTMLElement>(
        '[data-mcp-app-side-panel-frame-container="true"]',
      );
      const center = rect
        ? document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)
        : null;
      return {
        wrapperStyle: wrapper
          ? {
              display: getComputedStyle(wrapper).display,
              position: getComputedStyle(wrapper).position,
              zIndex: getComputedStyle(wrapper).zIndex,
              overflow: getComputedStyle(wrapper).overflow,
            }
          : null,
        wrapperRect: rect
          ? { left: rect.left, top: rect.top, width: rect.width, height: rect.height }
          : null,
        webviewStyle: webview
          ? {
              display: getComputedStyle(webview).display,
              visibility: getComputedStyle(webview).visibility,
            }
          : null,
        webviewRect: webviewRect
          ? {
              left: webviewRect.left,
              top: webviewRect.top,
              width: webviewRect.width,
              height: webviewRect.height,
            }
          : null,
        sideHostRect: sideHost
          ? (() => {
              const value = sideHost.getBoundingClientRect();
              return { left: value.left, top: value.top, width: value.width, height: value.height };
            })()
          : null,
        center: center
          ? {
              tag: center.tagName,
              id: (center as HTMLElement).id,
              className: (center as HTMLElement).className,
              dataset: { ...(center as HTMLElement).dataset },
            }
          : null,
      };
    });
    expect(lightFullscreenPaint.wrapperRect?.width ?? 0).toBeGreaterThan(0);
    expect(lightFullscreenPaint.webviewRect?.width ?? 0).toBeGreaterThan(0);
    expect(lightFullscreenPaint.center?.tag).toBe("WEBVIEW");
    await first.page
      .getByRole("button", { name: "Close Moss MCP App fixture", exact: true })
      .click();
    await expect(first.page.locator('[data-mcp-app-display-mode="inline"]')).toHaveCount(1);
    await expect(
      first.page.locator('[data-mcp-app-side-panel-frame-container="true"]'),
    ).toHaveCount(0);
    await expect(first.page.getByTitle("Moss MCP App fixture")).toHaveCount(0);
    expect(await first.page.locator('webview[data-mcp-app-sandbox="true"]').count()).toBe(1);
    expect((await fixtureState(first.application)).activeGuestId).toBe(guestIdBeforeFullscreen);

    await first.page.evaluate(() => {
      const fixture = (
        window as typeof window & {
          __mossMcpAppFixture: {
            updateTheme(theme: "light" | "dark"): void;
            resize(width: number, height: number): void;
            updateResult(resultText: string): void;
          };
        }
      ).__mossMcpAppFixture;
      fixture.updateTheme("dark");
      fixture.resize(390, 720);
      fixture.updateResult("fixture-result-updated");
    });
    await first.application.evaluate((_electron) => {
      const state = (
        globalThis as typeof globalThis & {
          __mossMcpAppE2E: { setWindowSize(width: number, height: number): void };
        }
      ).__mossMcpAppE2E;
      state.setWindowSize(390, 720);
    });
    await expect
      .poll(() => rendererGuestState(first!.application))
      .toMatchObject({
        theme: "dark",
      });
    await expect
      .poll(() => rendererGuestState(first!.application))
      .toMatchObject({
        toolResult: expect.stringContaining("fixture-result-updated"),
      });
    state = await fixtureState(first.application);
    expect(state.registerCount).toBe(1);
    assertGuestDiagnostics(state.diagnostics, false);
    expectGuestFrameToFillViewport(await rendererGuestFrameGeometry(first.application));
    const overflow = await first.page.evaluate(() => {
      const host = document.querySelector<HTMLElement>("#fixture-host");
      return {
        bodyScrollWidth: document.body.scrollWidth,
        bodyClientWidth: document.body.clientWidth,
        bodyScrollHeight: document.body.scrollHeight,
        bodyClientHeight: document.body.clientHeight,
        documentScrollWidth: document.documentElement.scrollWidth,
        documentScrollHeight: document.documentElement.scrollHeight,
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
        hostScrollWidth: host?.scrollWidth ?? -1,
        hostClientWidth: host?.clientWidth ?? -1,
      };
    });
    expect(overflow.bodyScrollWidth).toBeLessThanOrEqual(overflow.bodyClientWidth);
    expect(overflow.bodyScrollHeight).toBeLessThanOrEqual(overflow.bodyClientHeight);
    expect(overflow.documentScrollWidth).toBeLessThanOrEqual(overflow.viewportWidth);
    expect(overflow.documentScrollHeight).toBeLessThanOrEqual(overflow.viewportHeight);
    expect(overflow.hostScrollWidth).toBeLessThanOrEqual(overflow.hostClientWidth);
    const darkAppearance = await first.page.evaluate(() => {
      const card = document.querySelector<HTMLElement>(
        '[data-tool-detail-disclosure="true"][data-mcp-app-card="true"]',
      );
      const header = card?.querySelector<HTMLElement>('[data-tool-detail-header="true"]');
      return {
        cardBackground: card ? getComputedStyle(card).backgroundColor : "",
        cardForeground: card ? getComputedStyle(card).color : "",
        headerForeground: header ? getComputedStyle(header).color : "",
      };
    });
    expect(darkAppearance.cardBackground).not.toMatch(/255,\s*255,\s*255/u);
    expect(darkAppearance.cardForeground).not.toMatch(/0,\s*0,\s*0/u);
    expect(darkAppearance.headerForeground).not.toMatch(/0,\s*0,\s*0/u);
    await screenshot(first.page, resolve(EVIDENCE_DIR, "HEL-46-mcp-app-sandbox-dark-390.png"));

    const darkFullscreenReceipt = await fixtureGuest(
      first.application,
      `(async () => await document.querySelector("#mcp-app-frame")?.contentWindow?.__mossMcpApp?.requestDisplayMode({ mode: "fullscreen" }))()`,
    );
    expect(darkFullscreenReceipt).toEqual({ mode: "fullscreen" });
    await expect
      .poll(() =>
        first.page.evaluate(() => {
          const wrapper = document.querySelector<HTMLElement>(
            '[data-mcp-app-frame-wrapper="true"]',
          );
          const sideHost = document.querySelector<HTMLElement>(
            '[data-mcp-app-side-panel-frame-container="true"]',
          );
          if (!wrapper || !sideHost) return "missing";
          const wrapperRect = wrapper.getBoundingClientRect();
          const sideHostRect = sideHost.getBoundingClientRect();
          const deltas = [
            wrapperRect.left - sideHostRect.left,
            wrapperRect.top - sideHostRect.top,
            wrapperRect.width - sideHostRect.width,
            wrapperRect.height - sideHostRect.height,
          ];
          const aligned =
            wrapperRect.width > 0 &&
            sideHostRect.width > 0 &&
            deltas.every((delta) => Math.abs(delta) <= 1);
          return aligned
            ? "aligned"
            : JSON.stringify({
                wrapper: {
                  left: wrapperRect.left,
                  top: wrapperRect.top,
                  width: wrapperRect.width,
                  height: wrapperRect.height,
                },
                sideHost: {
                  left: sideHostRect.left,
                  top: sideHostRect.top,
                  width: sideHostRect.width,
                  height: sideHostRect.height,
                },
              });
        }),
      )
      .toBe("aligned");
    const darkFullscreenPaint = await first.page.evaluate(() => {
      const wrapper = document.querySelector<HTMLElement>('[data-mcp-app-frame-wrapper="true"]');
      const webview = document.querySelector<HTMLElement>('webview[data-mcp-app-sandbox="true"]');
      const sideHost = document.querySelector<HTMLElement>(
        '[data-mcp-app-side-panel-frame-container="true"]',
      );
      const rect = wrapper?.getBoundingClientRect();
      const webviewRect = webview?.getBoundingClientRect();
      const sideHostRect = sideHost?.getBoundingClientRect();
      const center = rect
        ? document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)
        : null;
      return {
        wrapperStyle: wrapper
          ? {
              display: getComputedStyle(wrapper).display,
              position: getComputedStyle(wrapper).position,
              zIndex: getComputedStyle(wrapper).zIndex,
            }
          : null,
        wrapperRect: rect
          ? { left: rect.left, top: rect.top, width: rect.width, height: rect.height }
          : null,
        webviewStyle: webview
          ? {
              display: getComputedStyle(webview).display,
              visibility: getComputedStyle(webview).visibility,
            }
          : null,
        webviewRect: webviewRect
          ? {
              left: webviewRect.left,
              top: webviewRect.top,
              width: webviewRect.width,
              height: webviewRect.height,
            }
          : null,
        sideHostRect: sideHostRect
          ? {
              left: sideHostRect.left,
              top: sideHostRect.top,
              width: sideHostRect.width,
              height: sideHostRect.height,
            }
          : null,
        center: center
          ? { tag: center.tagName, dataset: { ...(center as HTMLElement).dataset } }
          : null,
      };
    });
    expect(darkFullscreenPaint.wrapperStyle?.zIndex).toBe("51");
    expect(darkFullscreenPaint.wrapperStyle?.display).toBe("block");
    expect(darkFullscreenPaint.webviewStyle?.display).toBe("block");
    expect(darkFullscreenPaint.webviewStyle?.visibility).toBe("visible");
    expect(darkFullscreenPaint.wrapperRect?.width ?? 0).toBeGreaterThan(0);
    expect(darkFullscreenPaint.webviewRect?.width ?? 0).toBeGreaterThan(0);
    expect(darkFullscreenPaint.sideHostRect?.width ?? 0).toBeGreaterThan(0);
    for (const key of ["left", "top", "width", "height"] as const) {
      expect(
        Math.abs(darkFullscreenPaint.wrapperRect![key] - darkFullscreenPaint.sideHostRect![key]),
        JSON.stringify(darkFullscreenPaint),
      ).toBeLessThanOrEqual(1);
    }
    expect((await rendererGuestState(first.application)).toolResult).toContain(
      "fixture-result-updated",
    );
    await screenshot(first.page, resolve(EVIDENCE_DIR, "HEL-46-mcp-app-fullscreen-dark-390.png"));
    await expect(
      first.page.locator('[data-right-dock-content] [data-mcp-app-navigation-controls="true"]'),
    ).toHaveCount(1);
    await expect(
      first.page.locator(
        '[data-mcp-app-navigation-portal="true"] [data-mcp-app-navigation-controls="true"]',
      ),
    ).toHaveCount(0);
    await screenshot(
      first.page,
      resolve(EVIDENCE_DIR, "HEL-46-mcp-app-fullscreen-history-dark-390.png"),
    );
    await first.page
      .getByRole("button", { name: "Close Moss MCP App fixture", exact: true })
      .click();
    await expect(first.page.locator('[data-mcp-app-display-mode="inline"]')).toHaveCount(1);
    await expect(
      first.page.locator('[data-mcp-app-side-panel-frame-container="true"]'),
    ).toHaveCount(0);

    const security = (await fixtureGuest(first.application, SECURITY_PROBE_SCRIPT)) as {
      popup: boolean;
      egress: boolean;
      permissionApiAvailable: boolean;
      denied: boolean;
    };
    expect(security).toEqual({
      popup: true,
      egress: true,
      permissionApiAvailable: true,
      denied: true,
    });
    await first.page.waitForTimeout(100);
    const securityDiagnostics = (await fixtureState(first.application)).diagnostics;
    assertGuestDiagnostics(securityDiagnostics, true);
    const securityWindowUrls = first.application.windows().map((window) => window.url());
    expect(securityWindowUrls).toEqual(baselineWindowUrls);
    expect(
      readdirSync(home, { recursive: true }).some((entry) =>
        String(entry).includes("mcp-app-download"),
      ),
    ).toBe(false);

    const navigationBefore = (await fixtureState(first.application)).activeDescriptor?.src;
    await fixtureGuest(
      first.application,
      `(() => {
        const frame = document.querySelector("#mcp-app-frame");
        if (!frame?.contentWindow) return false;
        frame.contentWindow.location.href = "https://blocked.invalid/top-navigation";
        return true;
      })()`,
    );
    await first.page.waitForTimeout(100);
    state = await fixtureState(first.application);
    expect(state.activeGuests).toBe(1);
    expect(state.activeDescriptor?.src).toBe(navigationBefore);

    const authority = await first.application.evaluate((_electron) => {
      const state = (
        globalThis as typeof globalThis & {
          __mossMcpAppE2E: { authorityChecks: () => unknown };
        }
      ).__mossMcpAppE2E;
      return state.authorityChecks();
    });
    const denied = authority as {
      results: Record<string, { claimed: boolean; prevented: boolean }>;
      expired: { claimed: boolean; prevented: boolean };
    };
    for (const attempt of Object.values(denied.results)) {
      expect(attempt).toEqual({ claimed: true, prevented: true });
    }
    expect(denied.expired).toEqual({ claimed: true, prevented: true });

    const oldGuestId = state.activeGuestId;
    await first.application.evaluate((_electron) => {
      const fixture = (
        globalThis as typeof globalThis & {
          __mossMcpAppE2E: { setFailNextRegistration(value: boolean): void };
        }
      ).__mossMcpAppE2E;
      fixture.setFailNextRegistration(true);
    });
    await first.page.evaluate(async () => {
      const fixture = (
        window as typeof window & {
          __mossMcpAppFixture: { failGeneration: () => Promise<void> };
        }
      ).__mossMcpAppFixture;
      await fixture.failGeneration();
    });
    await expect(first.page.locator("#fixture-host")).toHaveAttribute(
      "data-phase",
      "sandbox_error",
    );
    await expect
      .poll(() => fixtureState(first!.application).then((value) => value.activeGuests))
      .toBe(0);
    state = await fixtureState(first.application);
    expect(state.activeGuests).toBe(0);
    expect(state.registeredPartitions).toBe(0);
    expect(state.partitionPolicies).toBe(0);

    await first.page.evaluate(async () => {
      const fixture = (
        window as typeof window & {
          __mossMcpAppFixture: { retry: () => Promise<void> };
        }
      ).__mossMcpAppFixture;
      await fixture.retry();
    });
    await expect(first.page.locator("#fixture-host")).toHaveAttribute("data-phase", "ready");
    const retriedDescriptor = await rendererDescriptor(first.page);
    expect(retriedDescriptor.partition).toBe(firstDescriptor.partition);
    expect(retriedDescriptor.initId).not.toBe(firstDescriptor.initId);
    expect(retriedDescriptor.generation).toBe(firstDescriptor.generation + 1);
    state = await fixtureState(first.application);
    expect(state.activeGuestId).not.toBe(oldGuestId);
    expect(state.activeGuests).toBe(1);
    const staleResult = await first.application.evaluate(
      (_electron, input) => {
        const state = (
          globalThis as typeof globalThis & {
            __mossMcpAppE2E: {
              sendStaleGuestInit: (guestId: number, descriptor: FixtureDescriptor) => unknown;
            };
          }
        ).__mossMcpAppE2E;
        return state.sendStaleGuestInit(input.guestId, input.descriptor);
      },
      { guestId: oldGuestId, descriptor: firstDescriptor },
    );
    expect((staleResult as FixtureState).activeGuests).toBe(1);

    await fixtureGuest(
      first.application,
      `(() => {
        const frame = document.querySelector("#mcp-app-frame");
        if (!frame?.contentWindow) return false;
        frame.contentWindow.parent.location.hash = "stale-authority";
        return true;
      })()`,
    );
    await expect
      .poll(() => fixtureState(first!.application).then((value) => value.activeGuests))
      .toBe(0);
    state = await fixtureState(first.application);
    expect(state.registeredPartitions).toBe(0);
    expect(state.partitionPolicies).toBe(0);
    assertGuestDiagnostics(state.diagnostics, true);

    expect(first.consoleErrors).toEqual([]);
    expect(first.consoleSecurityDenials.length).toBeGreaterThan(0);
    expect(
      first.consoleSecurityDenials.every((message) =>
        /404|content security policy/iu.test(message),
      ),
    ).toBe(true);
    expect(first.pageErrors).toEqual([]);
    expect(first.stderr.join("")).not.toMatch(
      /Electron Security Warning|Insecure Content-Security-Policy/u,
    );
    expect(state.processErrors).toEqual([]);
    await closeFixture(first);
    first = null;

    second = await launchFixture(home);
    const restartedGuestState = await rendererGuestState(second.application);
    expect(restartedGuestState.storageBefore).toBe("absent");
    let restartedState = await fixtureState(second.application);
    expect(restartedState.activeGuests).toBe(1);
    expect(restartedState.processErrors).toEqual([]);
    assertGuestDiagnostics(restartedState.diagnostics, false);
    const restartedSecurity = (await fixtureGuest(second.application, SECURITY_PROBE_SCRIPT)) as {
      popup: boolean;
      egress: boolean;
      permissionApiAvailable: boolean;
      denied: boolean;
    };
    expect(restartedSecurity).toEqual({
      popup: true,
      egress: true,
      permissionApiAvailable: true,
      denied: true,
    });
    await second.page.waitForTimeout(100);
    restartedState = await fixtureState(second.application);
    assertGuestDiagnostics(restartedState.diagnostics, true);
    expect(second.consoleErrors).toEqual([]);
    expect(second.consoleSecurityDenials.length).toBeGreaterThan(0);
    expect(
      second.consoleSecurityDenials.every((message) =>
        /404|content security policy/iu.test(message),
      ),
    ).toBe(true);
    expect(second.pageErrors).toEqual([]);
    expect(second.stderr.join("")).not.toMatch(
      /Electron Security Warning|Insecure Content-Security-Policy/u,
    );
  } finally {
    if (first) await closeFixture(first).catch(() => undefined);
    if (second) await closeFixture(second).catch(() => undefined);
    rmSync(home, { recursive: true, force: true });
  }
});
