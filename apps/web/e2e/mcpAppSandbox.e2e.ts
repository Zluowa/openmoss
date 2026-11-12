import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
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
// Every launch gets its own home under the run dir (never the real profile).
const RUN_DIR = process.env.MOSS_E2E_RUN_DIR ?? tmpdir();

function runHome(prefix: string): string {
  const home = join(RUN_DIR, `${prefix}-${crypto.randomUUID()}`);
  for (const child of ["appdata", "localappdata"])
    mkdirSync(join(home, child), { recursive: true });
  return home;
}

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

// ---------------------------------------------------------------------------
// Desktop sandbox boundary (interactive connectors): driven through a minimal
// trusted host page so these tests cover the registry, the Moss proxy page,
// both preloads and the main-process policy without the web host.
// ---------------------------------------------------------------------------

type ProxyEnvelope = {
  readonly at: number;
  readonly type: string;
  readonly message: Record<string, unknown>;
  readonly userActivation: boolean;
};

type ProxyDescriptor = {
  readonly sandboxId: string;
  readonly initId: string;
  readonly origin: string;
  readonly partition: string;
  readonly src: string;
  readonly generation: number;
};

type HostActions = {
  readonly fontRequests: number;
  readonly opened: readonly string[];
  readonly saveDialogs: readonly string[];
  readonly permissionDecisions: readonly string[];
};

const sha32 = (value: string) =>
  crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)).then((digest) =>
    [...new Uint8Array(digest)]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("")
      .slice(0, 32),
  );

/** Widget document: records every message from its parent in `window.__rx`. */
function widgetHtml(body = "", head = "", rootAttributes = ""): string {
  return `<!doctype html><html${rootAttributes}><head><meta charset="utf-8">${head}</head><body>
<script>
window.__rx = [];
window.__rxAt = [];
window.addEventListener("message", (event) => {
  if (event.source !== window.parent) return;
  window.__rx.push(event.data);
  window.__rxAt.push(performance.now());
});
window.__send = (method, params) => window.parent.postMessage({ jsonrpc: "2.0", method, params: params || {} }, "*");
</script>
${body}
</body></html>`;
}

class ProxyFixture {
  constructor(
    readonly application: ElectronApplication,
    readonly page: Page,
    readonly pageErrors: string[],
  ) {}

  static async launch(home: string): Promise<ProxyFixture> {
    const mainPath = process.env.MOSS_E2E_MCP_APP_MAIN;
    if (!mainPath) throw new Error("MCP App sandbox Electron main bundle was not prepared.");
    const application = await electron.launch({
      executablePath: requireFromDesktop("electron") as string,
      args: [mainPath],
      cwd: DESKTOP_DIR,
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        APPDATA: join(home, "appdata"),
        LOCALAPPDATA: join(home, "localappdata"),
        MOSS_HOME: home,
        MOSS_E2E_MCP_APP_START_PATH: "/proxy-host",
      },
      timeout: 45_000,
    });
    const stderr: string[] = [];
    application
      .process()
      .stderr?.on("data", (chunk: Buffer) => stderr.push(chunk.toString("utf8")));
    try {
      const page = await application.firstWindow({ timeout: 30_000 });
      const pageErrors: string[] = [];
      page.on("pageerror", (error) => pageErrors.push(error.message));
      await expect(page.locator("body")).toHaveAttribute("data-proxy-host", "ready", {
        timeout: 20_000,
      });
      return new ProxyFixture(application, page, pageErrors);
    } catch (error) {
      application.process().kill();
      throw new Error(`proxy host did not start: ${String(error)}; stderr=${stderr.join("")}`);
    }
  }

  mount(overrides: Record<string, unknown>): Promise<ProxyDescriptor> {
    return this.page.evaluate(async (input) => {
      const host = (
        window as unknown as { __proxyHost: { mount: (value: unknown) => Promise<unknown> } }
      ).__proxyHost;
      const descriptor = await host.mount(input);
      if (!descriptor) throw new Error("registration was refused");
      return descriptor as ProxyDescriptor;
    }, overrides);
  }

  host<T>(method: string, ...args: unknown[]): Promise<T> {
    return this.page.evaluate(
      ({ method: name, args: values }) => {
        const host = (
          window as unknown as { __proxyHost: Record<string, (...input: unknown[]) => unknown> }
        ).__proxyHost;
        return host[name]!(...values) as T;
      },
      { method, args },
    );
  }

  send(initId: string, message: unknown): Promise<void> {
    return this.host("send", initId, message);
  }

  notify(initId: string, method: string, params: Record<string, unknown> = {}): Promise<void> {
    return this.send(initId, { jsonrpc: "2.0", method, params });
  }

  resource(initId: string, html: string, permissions?: Record<string, unknown>): Promise<void> {
    return this.host("sendResource", initId, html, permissions);
  }

  received(initId: string): Promise<ProxyEnvelope[]> {
    return this.host("received", initId);
  }

  main<T>(name: string, ...args: unknown[]): Promise<T> {
    return this.application.evaluate(
      (_electron, input) => {
        const api = (
          globalThis as unknown as {
            __mossMcpAppE2E: Record<string, (...values: unknown[]) => unknown>;
          }
        ).__mossMcpAppE2E;
        return api[input.name]!(...input.args) as T;
      },
      { name, args },
    );
  }

  shell<T>(initId: string, script: string): Promise<T> {
    return this.main("executeInShell", initId, script);
  }

  widget<T>(initId: string, script: string, userGesture = false, timeoutMs?: number): Promise<T> {
    return this.main("executeInWidget", initId, script, userGesture, timeoutMs);
  }

  async waitForProxyReady(initId: string): Promise<void> {
    await expect
      .poll(async () => (await this.received(initId)).length, { timeout: 20_000 })
      .toBeGreaterThan(0);
  }

  async waitForWidget(initId: string): Promise<void> {
    try {
      await expect
        .poll(
          () =>
            this.widget<boolean>(initId, "Array.isArray(window.__rx)", false, 1_500).catch(
              () => false,
            ),
          {
            timeout: 20_000,
          },
        )
        .toBe(true);
    } catch (error) {
      const shell = await this.shell(
        initId,
        `(() => {
          const frame = document.querySelector("iframe");
          let widgetRuns = "opaque";
          try { widgetRuns = String(Array.isArray(frame?.contentWindow?.__rx)); } catch {}
          return { frames: document.querySelectorAll("iframe").length, srcdoc: (frame?.getAttribute("srcdoc") || "").length, widgetRuns };
        })()`,
      ).catch((reason: unknown) => String(reason));
      const frames = await this.main("widgetFrameInfo", initId).catch((reason: unknown) =>
        String(reason),
      );
      const state = await this.main<FixtureState>("state").catch(() => null);
      throw new Error(
        `widget did not start: ${String(error)}; shell=${JSON.stringify(shell)}; frames=${JSON.stringify(frames)}; console=${JSON.stringify(state?.diagnostics.guestConsoleErrors)}; denials=${JSON.stringify(state?.diagnostics.guestSecurityDenials)}; received=${JSON.stringify(await this.received(initId))}`,
      );
    }
  }

  /** Mount, wait for proxy-ready, inject the widget and wait until it runs. */
  async mountWidget(
    overrides: Record<string, unknown>,
    html: string,
    permissions?: Record<string, unknown>,
  ): Promise<ProxyDescriptor> {
    const descriptor = await this.mount(overrides);
    await this.waitForProxyReady(descriptor.initId);
    await this.resource(descriptor.initId, html, permissions);
    await this.waitForWidget(descriptor.initId);
    return descriptor;
  }

  widgetMessages(initId: string): Promise<Array<Record<string, unknown>>> {
    return this.widget(initId, "window.__rx");
  }

  shellScheme(initId: string): Promise<string> {
    return this.shell(initId, "document.documentElement.style.colorScheme");
  }

  innerAllow(initId: string): Promise<string | null> {
    return this.shell(initId, `document.querySelector("iframe").getAttribute("allow")`);
  }
}

const emptyCsp = {
  baseUriDomains: [],
  connectDomains: [],
  frameDomains: [],
  includeDefaultDomains: false,
  isTrusted: false,
  resourceDomains: [],
};

test.describe.serial("desktop widget sandbox (interactive connectors)", () => {
  test.setTimeout(120_000);
  let fixture: ProxyFixture;
  let home: string;

  test.beforeAll(async () => {
    home = runHome("moss-mcp-proxy");
    fixture = await ProxyFixture.launch(home);
  });

  test.afterAll(async () => {
    if (fixture) {
      const pid = fixture.application.process().pid;
      const closed = fixture.application.close().then(
        () => true,
        () => false,
      );
      const timedOut = new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 20_000));
      if (!(await Promise.race([closed, timedOut])) && pid !== undefined) {
        // Never leave a hidden Electron behind: end the whole process tree.
        try {
          execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
        } catch {
          // Already gone.
        }
      }
    }
    try {
      rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
    } catch {
      // A killed Electron can hold the profile briefly; the run dir is disposable.
    }
  });

  test("isolated widget: thread x server origin, opaque srcdoc frame, activation flag, theme pin", async () => {
    const descriptor = await fixture.mount({
      threadId: "t-iso",
      server: "srv",
      serverKey: "srv-key",
    });
    const label = await sha32("t-iso\u0000srv-key");
    expect(descriptor.sandboxId).toBe(label);
    expect(descriptor.origin).toBe(`moss-mcp-sandbox://${label}`);
    expect(descriptor.partition).toBe(`moss-mcp-${label}`);
    expect(descriptor.src).toMatch(
      new RegExp(`^moss-mcp-sandbox://${label}/mcp_apps\\?generation=0&route=[0-9a-f]{16}#init=`),
    );
    // Same thread and server key, another resource: same origin.
    const sibling = await fixture.mount({
      threadId: "t-iso",
      server: "srv",
      serverKey: "srv-key",
      callId: "sibling",
      resourceUri: "ui://fixture/other",
    });
    expect(sibling.sandboxId).toBe(label);

    await fixture.waitForProxyReady(descriptor.initId);
    const [ready] = await fixture.received(descriptor.initId);
    expect(ready).toMatchObject({
      type: "moss:mcp-app-message",
      message: { jsonrpc: "2.0", method: "ui/notifications/sandbox-proxy-ready", params: {} },
      userActivation: false,
    });
    await fixture.resource(descriptor.initId, widgetHtml());
    await fixture.waitForWidget(descriptor.initId);

    const isolation = await fixture.widget<Record<string, unknown>>(
      descriptor.initId,
      `(() => {
        let parentDocument = "reachable";
        try { void window.parent.document.body; } catch (error) { parentDocument = error.name; }
        let parentLocation = "reachable";
        try { void window.parent.location.href; } catch (error) { parentLocation = error.name; }
        let storage = "available";
        try { window.localStorage.getItem("x"); } catch (error) { storage = error.name; }
        return {
          origin: location.origin,
          href: location.href,
          parentDocument,
          parentLocation,
          storage,
          bridge: typeof window.desktopBridge,
          popup: window.open("https://example.com/", "_blank") === null,
        };
      })()`,
    );
    expect(isolation).toEqual({
      origin: "null",
      href: "about:srcdoc",
      parentDocument: "SecurityError",
      parentLocation: "SecurityError",
      storage: "SecurityError",
      bridge: "undefined",
      popup: true,
    });
    const shell = await fixture.shell<Record<string, unknown>>(
      descriptor.initId,
      `(() => {
        const frames = document.querySelectorAll("iframe");
        const frame = frames[0];
        return {
          frames: frames.length,
          sandbox: frame.getAttribute("sandbox"),
          allow: frame.getAttribute("allow"),
          srcdoc: frame.hasAttribute("srcdoc"),
          receiver: (frame.getAttribute("srcdoc") || "").includes("moss:print-theme"),
          bridge: typeof window.desktopBridge,
          origin: location.origin,
        };
      })()`,
    );
    expect(shell).toEqual({
      frames: 1,
      sandbox: "allow-scripts allow-forms",
      allow: "fullscreen *",
      srcdoc: true,
      receiver: true,
      bridge: "undefined",
      origin: `moss-mcp-sandbox://${label}`,
    });

    // Host -> widget and widget -> host, with the activation flag.
    await fixture.notify(descriptor.initId, "ui/notifications/host-ping", { n: 1 });
    await expect
      .poll(() => fixture.widgetMessages(descriptor.initId))
      .toContainEqual({ jsonrpc: "2.0", method: "ui/notifications/host-ping", params: { n: 1 } });
    await fixture.widget(descriptor.initId, `window.__send("ui/notifications/plain", { n: 1 })`);
    await fixture.widget(
      descriptor.initId,
      `window.__send("ui/notifications/gesture", { n: 2 })`,
      true,
    );
    await expect
      .poll(async () =>
        (await fixture.received(descriptor.initId)).map((item) => [
          item.message.method,
          item.userActivation,
        ]),
      )
      .toEqual([
        ["ui/notifications/sandbox-proxy-ready", false],
        ["ui/notifications/plain", false],
        ["ui/notifications/gesture", true],
      ]);
    expect(await fixture.host("invalid", descriptor.initId)).toEqual([]);

    // Theme pinning of the proxy page's own color-scheme.
    await fixture.send(descriptor.initId, {
      jsonrpc: "2.0",
      id: 1,
      result: { protocolVersion: "2026-01-26", hostContext: { theme: "dark" } },
    });
    await expect.poll(() => fixture.shellScheme(descriptor.initId)).toBe("dark");
    await fixture.notify(descriptor.initId, "ui/notifications/host-context-changed", {
      theme: "light",
    });
    await expect.poll(() => fixture.shellScheme(descriptor.initId)).toBe("light");
    await fixture.notify(descriptor.initId, "ui/notifications/host-context-changed", {
      displayMode: "inline",
    });
    await fixture.page.waitForTimeout(200);
    expect(await fixture.shellScheme(descriptor.initId)).toBe("light");
    await fixture.notify(descriptor.initId, "ui/notifications/host-context-changed", {
      theme: "sepia",
    });
    await expect.poll(() => fixture.shellScheme(descriptor.initId)).toBe("");
    await fixture.host("unmount", sibling.initId);
    await fixture.host("unmount", descriptor.initId);
  });

  test("stable-origin widget: connector-URL origin, same-origin frame, activation not forgeable", async () => {
    const descriptor = await fixture.mountWidget(
      {
        threadId: "t-stable",
        server: "conn",
        serverKey: "connector-1",
        stableOrigin: true,
        connectorUrl: "https://Connector.Example.com:443/mcp",
      },
      widgetHtml(),
    );
    const label = await sha32("https://connector.example.com/mcp");
    expect(descriptor.sandboxId).toBe(label);
    const info = await fixture.widget<Record<string, unknown>>(
      descriptor.initId,
      `({
        origin: location.origin,
        href: location.href.split("#")[0],
        sameAsParent: (() => { try { return window.parent.location.origin === location.origin; } catch { return false; } })(),
      })`,
    );
    expect(info).toEqual({
      origin: `moss-mcp-sandbox://${label}`,
      href: descriptor.src.split("#")[0],
      sameAsParent: true,
    });
    const shell = await fixture.shell<Record<string, unknown>>(
      descriptor.initId,
      `(() => {
        const frame = document.querySelector("iframe");
        return {
          sandbox: frame.getAttribute("sandbox"),
          allow: frame.getAttribute("allow"),
          srcdoc: frame.hasAttribute("srcdoc"),
          frames: document.querySelectorAll("iframe").length,
        };
      })()`,
    );
    expect(shell).toEqual({
      sandbox: "allow-scripts allow-same-origin allow-forms",
      allow: null,
      srcdoc: false,
      frames: 1,
    });
    await fixture.notify(descriptor.initId, "ui/notifications/host-ping", { stable: true });
    await expect
      .poll(() => fixture.widgetMessages(descriptor.initId))
      .toContainEqual({
        jsonrpc: "2.0",
        method: "ui/notifications/host-ping",
        params: { stable: true },
      });
    // A same-origin widget patching the proxy realm cannot forge the activation flag.
    await fixture.widget(
      descriptor.initId,
      `(() => {
        const forged = { get: () => ({ isActive: true, hasBeenActive: true }) };
        Object.defineProperty(window.parent.MessageEvent.prototype, "userActivation", forged);
        Object.defineProperty(window.parent.Navigator.prototype, "userActivation", forged);
        window.parent.Function.prototype.call = function () { return true; };
        window.__send("ui/notifications/forged");
      })()`,
    );
    await expect
      .poll(async () =>
        (await fixture.received(descriptor.initId))
          .filter((item) => item.message.method === "ui/notifications/forged")
          .map((item) => item.userActivation),
      )
      .toEqual([false]);
    // Nor can it catch the host port through a patched MessageEvent getter.
    await fixture.widget(
      descriptor.initId,
      `(() => {
        window.__caught = [];
        const proto = window.parent.MessageEvent.prototype;
        const targetOf = Object.getOwnPropertyDescriptor(window.parent.Event.prototype, "target").get;
        for (const name of ["data", "ports", "source", "origin"]) {
          const original = Object.getOwnPropertyDescriptor(proto, name).get;
          Object.defineProperty(proto, name, {
            configurable: true,
            get() {
              const target = targetOf.call(this);
              if (target instanceof window.parent.MessagePort) window.__caught.push(name);
              return original.call(this);
            },
          });
        }
      })()`,
    );
    await fixture.notify(descriptor.initId, "ui/notifications/host-ping", { after: "patch" });
    await expect
      .poll(() => fixture.widgetMessages(descriptor.initId))
      .toContainEqual({
        jsonrpc: "2.0",
        method: "ui/notifications/host-ping",
        params: { after: "patch" },
      });
    expect(await fixture.widget(descriptor.initId, "window.__caught")).toEqual([]);
    // Without a usable connector URL the widget stays isolated.
    const local = await fixture.mount({
      threadId: "t-stable",
      server: "local",
      stableOrigin: true,
    });
    expect(local.sandboxId).toBe(await sha32("t-stable\u0000local"));
    await fixture.host("unmount", local.initId);
    await fixture.host("unmount", descriptor.initId);
  });

  test("the widget's page fills its card: flex webview, guest viewport = slot height", async () => {
    for (const height of [400, 883]) {
      const descriptor = await fixture.mountWidget(
        {
          threadId: `t-fill-${height}`,
          containerDimensions: { height, width: 600 },
          csp: emptyCsp,
        },
        widgetHtml(),
      );
      // With display:block Electron leaves every guest 150 px tall whatever the slot is.
      await expect
        .poll(() => fixture.widget<number>(descriptor.initId, "window.innerHeight"), {
          timeout: 5_000,
        })
        .toBe(height);
      expect(await fixture.widget<number>(descriptor.initId, "window.innerWidth")).toBe(600);
      const display = await fixture.page.evaluate(
        (src) =>
          getComputedStyle(document.querySelector(`webview[src="${src}"]`) as HTMLElement).display,
        descriptor.src,
      );
      expect(display).toBe("flex");
    }
  });

  test("wheel the widget cannot use reaches the host once per frame as moss:wheel", async () => {
    const descriptor = await fixture.mountWidget(
      { threadId: "t-wheel", containerDimensions: { height: 400, width: 600 }, csp: emptyCsp },
      widgetHtml(
        `<div id="list" style="height:200px;overflow:auto"><div style="height:600px"></div></div>
<div style="height:150px"></div>`,
        "<style>html,body{margin:0}</style>",
      ),
    );
    const wheels = async () =>
      (await fixture.received(descriptor.initId))
        .map((item) => item.message)
        .filter((message) => message.type === "moss:wheel");
    const wheel = (selector: string, deltaY: number) =>
      fixture.widget(
        descriptor.initId,
        `(() => { const target = document.querySelector(${JSON.stringify(selector)});
          for (let i = 0; i < 3; i += 1) target.dispatchEvent(new WheelEvent("wheel", { deltaY: ${deltaY}, bubbles: true, cancelable: true }));
          return true; })()`,
      );
    // The page fits its 400 px card, so wheel over plain content goes to the transcript,
    // three events in one frame arriving as one message.
    await wheel("body", 40);
    await expect.poll(wheels).toEqual([{ type: "moss:wheel", deltaX: 0, deltaY: 120 }]);
    // An inner scroller that can still move keeps the wheel.
    await wheel("#list", 40);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(await wheels()).toHaveLength(1);
    // Once it is at its end, the rest carries on.
    await fixture.widget(descriptor.initId, `document.getElementById("list").scrollTop = 400`);
    await wheel("#list", 40);
    await expect.poll(async () => (await wheels()).length).toBe(2);
  });

  test("buffers host traffic until the widget runs: first load, first message, 5 s timeout", async () => {
    // (a) Flush on the widget's first load: sent before the srcdoc document exists.
    const loaded = await fixture.mount({ threadId: "t-buffer-load", server: "srv" });
    await fixture.waitForProxyReady(loaded.initId);
    await fixture.resource(loaded.initId, widgetHtml());
    for (const n of [1, 2, 3]) {
      await fixture.notify(loaded.initId, "ui/notifications/early", { n });
    }
    await expect
      .poll(() => fixture.widgetMessages(loaded.initId).catch(() => []))
      .toEqual(
        [1, 2, 3].map((n) => ({ jsonrpc: "2.0", method: "ui/notifications/early", params: { n } })),
      );

    // A pending sub-resource holds back the widget's load event from here on.
    await fixture.main("setFontHang", true);
    const hanging = `<img src="moss-mcp-sandbox://assets/fonts/inter-latin.woff2" alt="">`;

    // (b) Flush on the widget's first message (before load, before the timeout).
    const firstMessage = await fixture.mount({ threadId: "t-buffer-message", server: "srv" });
    await fixture.waitForProxyReady(firstMessage.initId);
    await fixture.resource(
      firstMessage.initId,
      widgetHtml(
        `${hanging}<script>setTimeout(() => window.__send("ui/notifications/hello"), 1200);</script>`,
      ),
    );
    await fixture.notify(firstMessage.initId, "ui/notifications/queued", { n: 1 });
    await fixture.waitForWidget(firstMessage.initId);
    expect(await fixture.widgetMessages(firstMessage.initId)).toEqual([]);
    await expect
      .poll(() => fixture.widgetMessages(firstMessage.initId), { timeout: 4_000 })
      .toEqual([{ jsonrpc: "2.0", method: "ui/notifications/queued", params: { n: 1 } }]);
    const firstMessageTiming = await fixture.widget<{ readyState: string; at: number }>(
      firstMessage.initId,
      `({ readyState: document.readyState, at: window.__rxAt[0] })`,
    );
    expect(firstMessageTiming.readyState).not.toBe("complete");
    expect(firstMessageTiming.at).toBeGreaterThanOrEqual(1_150);
    expect(firstMessageTiming.at).toBeLessThan(4_500);

    // (c) Flush on the 5 s timeout when the widget neither loads nor speaks, and
    // (d) re-injection drops traffic queued for the superseded document.
    const timeout = await fixture.mount({ threadId: "t-buffer-timeout", server: "srv" });
    await fixture.waitForProxyReady(timeout.initId);
    await fixture.resource(timeout.initId, widgetHtml(hanging));
    await fixture.notify(timeout.initId, "ui/notifications/queued", { n: 1 });
    await fixture.resource(timeout.initId, widgetHtml(hanging));
    await fixture.notify(timeout.initId, "ui/notifications/queued", { n: 2 });
    await fixture.waitForWidget(timeout.initId);
    await fixture.page.waitForTimeout(2_500);
    expect(await fixture.widgetMessages(timeout.initId)).toEqual([]);
    await expect
      .poll(() => fixture.widgetMessages(timeout.initId), { timeout: 6_000 })
      .toEqual([{ jsonrpc: "2.0", method: "ui/notifications/queued", params: { n: 2 } }]);
    const timeoutAt = await fixture.widget<number>(timeout.initId, "window.__rxAt[0]");
    expect(timeoutAt).toBeGreaterThanOrEqual(4_500);
    await fixture.main("setFontHang", false);
    for (const descriptor of [loaded, firstMessage, timeout]) {
      await fixture.host("unmount", descriptor.initId);
    }
  });

  test("heals tool-input-delta into tool-input-partial and resets on tool-input", async () => {
    const descriptor = await fixture.mountWidget(
      { threadId: "t-delta", server: "srv" },
      widgetHtml(),
    );
    for (const delta of ['{"ci', 'ty":"Par', 'is","days":[1', ",2", "]}", ',"x":1}']) {
      await fixture.notify(descriptor.initId, "ui/notifications/tool-input-delta", { delta });
    }
    await fixture.notify(descriptor.initId, "ui/notifications/tool-input", {
      arguments: { city: "Paris", days: [1, 2] },
    });
    await fixture.notify(descriptor.initId, "ui/notifications/tool-input-delta", {
      delta: '{"b":tr',
    });
    await fixture.notify(descriptor.initId, "ui/notifications/tool-input-delta", { delta: "" });
    await fixture.notify(descriptor.initId, "ui/notifications/tool-input-delta", { delta: 7 });
    const partial = (args: unknown) => ({
      jsonrpc: "2.0",
      method: "ui/notifications/tool-input-partial",
      params: { arguments: args },
    });
    await expect
      .poll(() => fixture.widgetMessages(descriptor.initId))
      .toEqual([
        partial({}),
        partial({ city: "Par" }),
        partial({ city: "Paris", days: [1] }),
        partial({ city: "Paris", days: [1, 2] }),
        partial({ city: "Paris", days: [1, 2] }),
        partial({ city: "Paris", days: [1, 2] }),
        {
          jsonrpc: "2.0",
          method: "ui/notifications/tool-input",
          params: { arguments: { city: "Paris", days: [1, 2] } },
        },
        partial({ b: true }),
      ]);
    await fixture.host("unmount", descriptor.initId);
  });

  test("print theme: widget forced light while printing, follows the latest host theme after", async () => {
    const descriptor = await fixture.mountWidget(
      { threadId: "t-print", server: "srv" },
      widgetHtml("", "", ' data-mode="light" style="color-scheme: light"'),
    );
    await fixture.notify(descriptor.initId, "ui/notifications/host-context-changed", {
      theme: "light",
    });
    await expect.poll(() => fixture.shellScheme(descriptor.initId)).toBe("light");
    const widgetTheme = () =>
      fixture.widget<Record<string, unknown>>(
        descriptor.initId,
        `({
          scheme: document.documentElement.style.colorScheme,
          mode: document.documentElement.getAttribute("data-mode"),
          force: Boolean(document.getElementById("moss-print-force-light")),
        })`,
      );
    await fixture.shell(descriptor.initId, `window.dispatchEvent(new Event("beforeprint"))`);
    await expect.poll(widgetTheme).toEqual({ scheme: "light", mode: "light", force: true });
    expect(await fixture.shellScheme(descriptor.initId)).toBe("light");
    // A theme change mid-print is held until afterprint.
    await fixture.notify(descriptor.initId, "ui/notifications/host-context-changed", {
      theme: "dark",
    });
    await fixture.page.waitForTimeout(200);
    expect(await fixture.shellScheme(descriptor.initId)).toBe("light");
    await fixture.shell(descriptor.initId, `window.dispatchEvent(new Event("afterprint"))`);
    await expect.poll(widgetTheme).toEqual({ scheme: "dark", mode: "dark", force: false });
    expect(await fixture.shellScheme(descriptor.initId)).toBe("dark");
    const types = (await fixture.widgetMessages(descriptor.initId)).map(
      (message) => (message.type as string | undefined) ?? (message.method as string),
    );
    expect(types).toEqual([
      "ui/notifications/host-context-changed",
      "moss:print-theme",
      "ui/notifications/host-context-changed",
      "moss:print-theme",
    ]);
    await fixture.host("unmount", descriptor.initId);
  });

  test("a widget that navigates its own frame loses the channel both ways", async () => {
    const zombie = encodeURIComponent(
      `<script>window.__rx=[];addEventListener("message",e=>__rx.push(e.data));setInterval(()=>parent.postMessage({jsonrpc:"2.0",method:"ui/notifications/zombie"},"*"),100);</script>`,
    );
    const descriptor = await fixture.mountWidget(
      { threadId: "t-dead", server: "srv" },
      widgetHtml(
        `<script>window.__send("ui/notifications/alive"); setTimeout(() => { location.href = "data:text/html,${zombie}"; }, 400);</script>`,
      ),
    );
    await expect
      .poll(async () =>
        (await fixture.received(descriptor.initId)).map((item) => item.message.method),
      )
      .toContain("ui/notifications/alive");
    await expect
      .poll(() => fixture.widget<string>(descriptor.initId, "location.protocol").catch(() => ""))
      .toBe("data:");
    await fixture.page.waitForTimeout(1_200);
    await fixture.notify(descriptor.initId, "ui/notifications/after-death");
    await fixture.page.waitForTimeout(400);
    const methods = (await fixture.received(descriptor.initId)).map((item) => item.message.method);
    expect(methods).not.toContain("ui/notifications/zombie");
    expect(await fixture.widget(descriptor.initId, "window.__rx")).toEqual([]);
    await fixture.host("unmount", descriptor.initId);
  });

  test("CSP: declared connect and frame sites allowed, everything else blocked, font served", async () => {
    const descriptor = await fixture.mountWidget(
      {
        threadId: "t-csp",
        server: "srv",
        csp: {
          ...emptyCsp,
          baseUriDomains: ["https://base.example.com"],
          connectDomains: ["https://allowed.example.invalid"],
          frameDomains: [
            "https://frames.example.com",
            "https://claude.ai",
            "https://x.inkcomicai.com",
          ],
        },
      },
      widgetHtml(`<script>
        window.__violations = [];
        document.addEventListener("securitypolicyviolation", (event) => {
          window.__violations.push(event.effectiveDirective + " " + event.blockedURI);
        });
      </script>`),
    );
    const result = await fixture.widget<Record<string, unknown>>(
      descriptor.initId,
      `(async () => {
        const outcome = async (promise) => { try { await promise; return "ok"; } catch (error) { return error.name; } };
        const allowed = await outcome(fetch("https://allowed.example.invalid/data"));
        const blocked = await outcome(fetch("https://blocked.example.invalid/data"));
        const sandboxFetch = await outcome(fetch("moss-mcp-sandbox://assets/fonts/inter-latin.woff2"));
        const font = new FontFace("Inter", "url(moss-mcp-sandbox://assets/fonts/inter-latin.woff2)");
        let fontStatus;
        try { await font.load(); fontStatus = font.status; } catch (error) { fontStatus = "error:" + error.name; }
        for (const src of ["https://frames.example.com/embed", "https://claude.ai/", "https://x.inkcomicai.com/", "https://other.example.com/"]) {
          const frame = document.createElement("iframe");
          frame.src = src;
          document.body.append(frame);
        }
        let rtc;
        try { new RTCPeerConnection({ iceServers: [{ urls: "stun:stun.example.invalid:3478" }] }); rtc = "constructed"; } catch (error) { rtc = error.name; }
        await new Promise((resolve) => setTimeout(resolve, 800));
        return { allowed, blocked, sandboxFetch, fontStatus, rtc, violations: window.__violations };
      })()`,
    );
    expect(result.allowed).toBe("TypeError");
    expect(result.blocked).toBe("TypeError");
    expect(result.sandboxFetch).toBe("TypeError");
    expect(result.fontStatus).toBe("loaded");
    const violations = result.violations as string[];
    // Cross-origin violation reports carry the blocked origin only.
    expect(violations).toEqual(
      expect.arrayContaining([
        "connect-src https://blocked.example.invalid/data",
        expect.stringMatching(/^connect-src moss-mcp-sandbox/u),
        expect.stringMatching(/^frame-src https:\/\/claude\.ai/u),
        expect.stringMatching(/^frame-src https:\/\/x\.inkcomicai\.com/u),
        expect.stringMatching(/^frame-src https:\/\/other\.example\.com/u),
      ]),
    );
    expect(violations.some((entry) => entry.includes("allowed.example.invalid"))).toBe(false);
    expect(violations.some((entry) => entry.includes("frames.example.com"))).toBe(false);
    expect((await fixture.main<HostActions>("hostActions")).fontRequests).toBeGreaterThan(0);
    const state = await fixture.main<FixtureState>("state");
    expect(state.diagnostics.guestSecurityDenials.join("\n")).not.toContain(
      "allowed.example.invalid",
    );
    // Frame sites withhold device permissions and fullscreen from the widget frame.
    expect(await fixture.innerAllow(descriptor.initId)).toBe(null);
    test.info().annotations.push({ type: "webrtc", description: String(result.rtc) });
    await fixture.host("unmount", descriptor.initId);
  });

  test("device permissions: denied until granted, declared keys only, never with frame sites", async () => {
    const descriptor = await fixture.mountWidget(
      { threadId: "t-perm", server: "srv", permissions: { camera: true, geolocation: true } },
      widgetHtml(),
      { camera: {}, geolocation: {}, microphone: {} },
    );
    expect(await fixture.innerAllow(descriptor.initId)).toBe(
      "fullscreen *; camera *; geolocation *",
    );
    // Media uses Chromium's fake capture devices (fixture switch); location is
    // only ever requested while it is denied, so no platform provider runs.
    const probe = (withPosition: boolean) => `(async () => {
      const query = async (name) => { try { return (await navigator.permissions.query({ name })).state; } catch (error) { return "error:" + error.name; } };
      const media = async (constraints) => { try { const stream = await navigator.mediaDevices.getUserMedia(constraints); stream.getTracks().forEach((track) => track.stop()); return "ok"; } catch (error) { return error.name + ": " + error.message; } };
      const geolocation = ${withPosition} ? await new Promise((resolve) => navigator.geolocation.getCurrentPosition(() => resolve("ok"), (error) => resolve("code:" + error.code), { timeout: 1500 })) : "skipped";
      return {
        camera: await query("camera"),
        microphone: await query("microphone"),
        geolocationQuery: await query("geolocation"),
        video: await media({ video: true }),
        audio: await media({ audio: true }),
        geolocation,
      };
    })()`;
    const decisions = async () =>
      (await fixture.main<HostActions>("hostActions")).permissionDecisions;
    const before = await fixture.widget<Record<string, string>>(descriptor.initId, probe(true));
    expect(before.geolocation).toBe("code:1");
    expect(before.camera).not.toBe("granted");
    expect(before.geolocationQuery).not.toBe("granted");
    expect(await decisions()).toContain("request:geolocation::false");
    // Chromium itself refuses capture in an opaque-origin frame; capture is
    // exercised in the stable-origin variant below.
    expect(before.video).toMatch(/^(SecurityError|NotAllowedError)/u);

    // microphone was not declared by the resource, so it is not granted.
    expect(
      await fixture.host("requestPermissions", descriptor.sandboxId, {
        camera: true,
        microphone: true,
      }),
    ).toEqual({ granted: { camera: true } });
    const cameraGranted = await fixture.widget<Record<string, string>>(
      descriptor.initId,
      probe(true),
    );
    expect(cameraGranted).toMatchObject({ camera: "granted", geolocation: "code:1" });
    expect(cameraGranted.microphone).not.toBe("granted");
    expect(cameraGranted.geolocationQuery).not.toBe("granted");

    // Exactly the approved set: a new grant replaces the previous one.
    expect(
      await fixture.host("requestPermissions", descriptor.sandboxId, { geolocation: true }),
    ).toEqual({ granted: { geolocation: true } });
    const geolocationGranted = await fixture.widget<Record<string, string>>(
      descriptor.initId,
      probe(false),
    );
    expect(geolocationGranted.geolocationQuery).toBe("granted");
    expect(geolocationGranted.camera).not.toBe("granted");
    await fixture.host("unmount", descriptor.initId);

    // Capture through the request handler (stable-origin widget, fake devices).
    const stable = await fixture.mountWidget(
      {
        threadId: "t-perm-stable",
        server: "conn",
        stableOrigin: true,
        connectorUrl: "https://camera.example.com/mcp",
        permissions: { camera: true },
      },
      widgetHtml(),
      { camera: {}, microphone: {} },
    );
    expect(await fixture.innerAllow(stable.initId)).toBe("camera *");
    const stableBefore = await fixture.widget<Record<string, string>>(stable.initId, probe(false));
    expect(stableBefore.video).toMatch(/^NotAllowedError/u);
    expect(await decisions()).toContain("request:media:video:false");
    expect(
      await fixture.host("requestPermissions", stable.sandboxId, {
        camera: true,
        microphone: true,
      }),
    ).toEqual({ granted: { camera: true } });
    const stableAfter = await fixture.widget<Record<string, string>>(stable.initId, probe(false));
    expect(stableAfter.video).toBe("ok");
    expect(stableAfter.audio).toMatch(/^(NotAllowedError|SecurityError)/u);
    expect(await decisions()).toContain("request:media:video:true");
    test.info().annotations.push({
      type: "permissions",
      description: JSON.stringify({
        before,
        cameraGranted,
        geolocationGranted,
        stableBefore,
        stableAfter,
      }),
    });
    await fixture.host("unmount", stable.initId);

    const framed = await fixture.mountWidget(
      {
        threadId: "t-perm-framed",
        server: "srv",
        permissions: { camera: true },
        csp: { ...emptyCsp, frameDomains: ["https://frames.example.com"] },
      },
      widgetHtml(),
      { camera: {} },
    );
    expect(await fixture.host("requestPermissions", framed.sandboxId, { camera: true })).toEqual({
      granted: {},
    });
    expect(await fixture.innerAllow(framed.initId)).toBe(null);
    const framedProbe = await fixture.widget<Record<string, string>>(framed.initId, probe(false));
    expect(framedProbe.video).toMatch(/^(SecurityError|NotAllowedError)/u);
    expect(framedProbe.camera).not.toBe("granted");
    await fixture.host("unmount", framed.initId);
  });

  test("openExternal and saveDownload: trusted host only, scheme allow-list, save dialog", async () => {
    expect(await fixture.host("bridgeKeys")).toEqual([
      "openExternal",
      "register",
      "requestPermissions",
      "saveDownload",
      "unregister",
    ]);
    const cases: ReadonlyArray<readonly [string, boolean]> = [
      ["https://example.com/docs?a=1", true],
      ["mailto:someone@example.com", true],
      ["tel:+8610123456", true],
      ["sms:+8610123456", true],
      ["javascript:alert(1)", false],
      ["file:///C:/Windows/System32/calc.exe", false],
      ["ms-settings:privacy", false],
      ["moss-mcp-sandbox://assets/fonts/inter-latin.woff2", false],
    ];
    for (const [url, opened] of cases) {
      expect(await fixture.host("openExternal", url), url).toEqual({ opened });
    }
    expect((await fixture.main<HostActions>("hostActions")).opened).toEqual([
      "https://example.com/docs?a=1",
      "mailto:someone@example.com",
      "tel:+8610123456",
      "sms:+8610123456",
    ]);

    await fixture.main("setSaveAnswer", "saved.txt");
    expect(
      await fixture.host("saveDownload", {
        fileName: "../报告.txt",
        mimeType: "text/plain",
        text: "你好",
      }),
    ).toEqual({ saved: true });
    expect(await fixture.main("readSaved", "saved.txt")).toBe(
      Buffer.from("你好").toString("base64"),
    );
    await fixture.main("setSaveAnswer", null);
    expect(
      await fixture.host("saveDownload", {
        fileName: "a.bin",
        mimeType: "application/octet-stream",
        base64: "AAEC",
      }),
    ).toEqual({ saved: false });
    expect(
      await fixture.host("saveDownload", { fileName: "a.txt", mimeType: "text/plain" }),
    ).toEqual({ saved: false });
    const dialogs = (await fixture.main<HostActions>("hostActions")).saveDialogs;
    expect(dialogs).toHaveLength(2);
    expect(dialogs[0]).toBe(join(home, "downloads", "报告.txt"));
  });

  test("keeps the existing denials: popups, downloads, proxy page navigation", async () => {
    const descriptor = await fixture.mountWidget(
      { threadId: "t-deny", server: "srv" },
      widgetHtml(),
    );
    const popupBlocked = await fixture.widget<boolean>(
      descriptor.initId,
      `(() => {
        const link = document.createElement("a");
        link.href = "data:text/plain,secret";
        link.download = "secret.txt";
        document.body.append(link);
        link.click();
        return window.open("https://example.com/") === null;
      })()`,
    );
    expect(popupBlocked).toBe(true);
    await fixture
      .shell(descriptor.initId, `location.href = "https://example.com/"`)
      .catch(() => undefined);
    await fixture.page.waitForTimeout(500);
    const info = await fixture.main<{ shellUrl: string }>("widgetFrameInfo", descriptor.initId);
    expect(info.shellUrl).toBe(descriptor.src);
    const state = await fixture.main<FixtureState>("state");
    expect(state.diagnostics.preloadErrors).toEqual([]);
    expect(fixture.pageErrors).toEqual([]);
    await fixture.host("unmount", descriptor.initId);
  });
});
