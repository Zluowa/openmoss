// FILE: desktop.ts
// Purpose: Shell half of the `desktop` capability (`moss.use("desktop")`):
// relays desktop window, Menu, dock, tray, notification, globalShortcut,
// screen, install, permissions, os, fs, shell, childProcess, and pty calls
// to `desktopBridge.pageApps` in the main window or `window.mossDesktop` in
// standalone desktop windows.
// Layer: Web pageApps capability

import {
  filterDeclaredDesktopPermissions,
  type DesktopPageAppInstallPlace,
  type DesktopPageAppInstallState,
  type DesktopPageAppNativeGlobal,
  type DesktopPageAppNodeApiEvent,
  type DesktopPageAppPaneInfo,
  type DesktopPageAppsBridge,
  type InstalledDesktopPageApp,
  type PageAppCapabilities,
  type PageAppDesktopPermission,
  type PageAppId,
} from "@moss/contracts";
import {
  PageAppCapabilityError,
  toPageAppCallError,
  type PageAppShellContext,
  type PageAppShellPlugin,
} from "@moss/shared/pageAppCapabilityPlugin";

type WindowWithDesktopGlobals = Window & {
  mossDesktop?: DesktopPageAppNativeGlobal;
  mossApps?: DesktopPageAppNativeGlobal;
  mossDesktopAppPane?: DesktopPageAppPaneInfo;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

export function getDesktopPageAppsBridge(): DesktopPageAppsBridge | null {
  if (typeof window === "undefined") return null;
  return window.desktopBridge?.pageApps ?? null;
}

export function getDesktopNativeGlobal(): DesktopPageAppNativeGlobal | null {
  if (typeof window === "undefined") return null;
  const win = window as WindowWithDesktopGlobals;
  return win.mossDesktop ?? win.mossApps ?? null;
}

export function getDesktopNativePane(): DesktopPageAppPaneInfo | null {
  if (typeof window === "undefined") return null;
  const win = window as WindowWithDesktopGlobals;
  return win.mossDesktopAppPane ?? null;
}

export function readDeclaredDesktopPermissions(
  capabilities: PageAppCapabilities | undefined,
): PageAppDesktopPermission[] {
  if (!capabilities) return [];
  const rawDesktop = capabilities.desktop;
  if (isRecord(rawDesktop) && rawDesktop.permissions !== undefined) {
    return filterDeclaredDesktopPermissions(rawDesktop.permissions);
  }
  return [];
}

export function readTransparentFromWindowPayload(payload: unknown): boolean | null {
  if (!isRecord(payload)) return null;
  if (isRecord(payload.applied) && typeof payload.applied.transparent === "boolean") {
    return payload.applied.transparent;
  }
  if (isRecord(payload.options) && typeof payload.options.transparent === "boolean") {
    return payload.options.transparent;
  }
  if (typeof payload.transparent === "boolean") {
    return payload.transparent;
  }
  return null;
}

function normalizeInstallState(
  raw: unknown,
  fallbackAvailable: boolean,
): DesktopPageAppInstallState {
  const rec = isRecord(raw) ? raw : {};
  const app = isRecord(rec.app) ? (rec.app as InstalledDesktopPageApp) : null;
  const installed = typeof rec.installed === "boolean" ? rec.installed : Boolean(app);
  const available = typeof rec.available === "boolean" ? rec.available : fallbackAvailable;
  const installId = typeof rec.installId === "string" ? rec.installId : (app?.installId ?? null);
  const name = typeof rec.name === "string" && rec.name.length > 0 ? rec.name : app?.name;
  const places = Array.isArray(rec.places)
    ? (rec.places as DesktopPageAppInstallPlace[])
    : app?.places
      ? [...app.places]
      : [];
  const policy = isRecord(rec.policy)
    ? (rec.policy as DesktopPageAppInstallState["policy"])
    : undefined;
  return {
    installed,
    available,
    installId,
    ...(name ? { name } : {}),
    places,
    app,
    ...(policy ? { policy } : {}),
  };
}

function unavailableError(): PageAppCapabilityError {
  return new PageAppCapabilityError(
    "unavailable",
    "Desktop capabilities are only available inside Moss Desktop.",
  );
}

async function handleInstallCall(
  ctx: PageAppShellContext,
  innerMethod: string,
  innerArgs: unknown,
  bridge: DesktopPageAppsBridge | null,
  native: DesktopPageAppNativeGlobal | null,
): Promise<unknown> {
  const appId = ctx.appId as PageAppId;
  if (innerMethod === "state") {
    if (bridge) {
      const [availableFlag, installedApp, installedFlag, policy] = await Promise.all([
        bridge.isAvailable().catch(() => false),
        typeof bridge.getInstalled === "function"
          ? bridge.getInstalled(appId).catch(() => null)
          : Promise.resolve(null),
        bridge.isInstalled(appId).catch(() => false),
        typeof bridge.getPolicyState === "function"
          ? bridge.getPolicyState().catch(() => null)
          : Promise.resolve(null),
      ]);
      const installed = Boolean(installedApp ?? installedFlag);
      return {
        installed,
        available: Boolean(availableFlag),
        installId: installedApp?.installId ?? null,
        ...(installedApp?.name ? { name: installedApp.name } : {}),
        places: installedApp?.places ? [...installedApp.places] : [],
        app: installedApp ?? null,
        ...(policy ? { policy } : {}),
      } satisfies DesktopPageAppInstallState;
    }
    if (native && typeof native.invoke === "function") {
      const raw = await native.invoke("install", "state", innerArgs ?? null);
      return normalizeInstallState(raw, true);
    }
    throw unavailableError();
  }
  if (innerMethod === "request") {
    if (bridge) {
      const rect = ctx.frameElement?.()?.getBoundingClientRect();
      return bridge.requestInstall({
        appId,
        title: ctx.title,
        revision: ctx.revision,
        capabilities: ctx.capabilities,
        ...(rect
          ? {
              sourceRect: {
                x: rect.left,
                y: rect.top,
                width: rect.width,
                height: rect.height,
              },
            }
          : {}),
      });
    }
    if (native && typeof native.invoke === "function") {
      return native.invoke("install", "request", innerArgs ?? null);
    }
    throw unavailableError();
  }
  throw new PageAppCapabilityError("invalid_argument", `install has no "${innerMethod}".`);
}

async function handlePermissionsCall(
  ctx: PageAppShellContext,
  innerMethod: string,
  innerArgs: unknown,
  declared: readonly PageAppDesktopPermission[],
  bridge: DesktopPageAppsBridge | null,
  native: DesktopPageAppNativeGlobal | null,
): Promise<unknown> {
  const appId = ctx.appId as PageAppId;
  if (innerMethod === "state") {
    if (bridge && typeof bridge.getPermissions === "function") {
      const summary = await bridge.getPermissions({
        appId,
        revision: ctx.revision,
        declared: [...declared],
      });
      if (isRecord(innerArgs) && typeof innerArgs.name === "string") {
        return summary.states[innerArgs.name] ?? "unavailable";
      }
      return summary.states;
    }
    if (native && typeof native.invoke === "function") {
      return native.invoke("permissions", "state", innerArgs ?? null);
    }
    throw unavailableError();
  }
  if (innerMethod === "request") {
    const requested =
      isRecord(innerArgs) && innerArgs.names !== undefined
        ? filterDeclaredDesktopPermissions(innerArgs.names)
        : [...declared];
    if (bridge && typeof bridge.requestPermissions === "function") {
      return bridge.requestPermissions({
        appId,
        revision: ctx.revision,
        title: ctx.title,
        permissions: requested,
      });
    }
    if (native && typeof native.invoke === "function") {
      return native.invoke("permissions", "request", { names: requested });
    }
    throw unavailableError();
  }
  if (innerMethod === "declare") {
    if (native && typeof native.invoke === "function") {
      return native.invoke("permissions", "declare", innerArgs ?? null);
    }
    if (bridge) {
      return [...declared];
    }
    throw unavailableError();
  }
  if (innerMethod === "manage") {
    if (bridge && typeof bridge.openPermissions === "function") {
      await bridge.openPermissions({
        appId,
        title: ctx.title,
        revision: ctx.revision,
        permissions: [...declared],
      });
      return null;
    }
    if (native && typeof native.invoke === "function") {
      return native.invoke("permissions", "manage", innerArgs ?? null);
    }
    throw unavailableError();
  }
  throw new PageAppCapabilityError("invalid_argument", `permissions has no "${innerMethod}".`);
}

export const desktopShellPlugin: PageAppShellPlugin = {
  name: "desktop",
  consent: "none",
  modes: ["full", "embed"],
  label: "桌面应用",
  purpose: "使用桌面窗口与系统能力",
  rateLimit: { burst: 60, perMinute: 600 },
  call: async (ctx, method, args) => {
    if (method !== "invoke") {
      throw new PageAppCapabilityError("invalid_argument", `desktop has no "${method}".`);
    }
    if (!isRecord(args) || typeof args.namespace !== "string" || typeof args.method !== "string") {
      throw new PageAppCapabilityError(
        "invalid_argument",
        "desktop.invoke requires { namespace, method }.",
      );
    }

    const bridge = getDesktopPageAppsBridge();
    const native = getDesktopNativeGlobal();
    const declared = readDeclaredDesktopPermissions(ctx.capabilities);
    const { namespace, method: innerMethod } = args;
    const innerArgs = args.args ?? null;

    if (namespace === "install") {
      return handleInstallCall(ctx, innerMethod, innerArgs, bridge, native);
    }
    if (namespace === "permissions") {
      return handlePermissionsCall(ctx, innerMethod, innerArgs, declared, bridge, native);
    }

    try {
      if (bridge && typeof bridge.invokeDesktopApi === "function") {
        return await bridge.invokeDesktopApi({
          appId: ctx.appId as PageAppId,
          revision: ctx.revision,
          namespace,
          method: innerMethod,
          args: innerArgs,
        });
      }
      if (native && typeof native.invoke === "function") {
        return await native.invoke(namespace, innerMethod, innerArgs);
      }
    } catch (error) {
      throw new PageAppCapabilityError(
        toPageAppCallError(error).code,
        toPageAppCallError(error).message,
      );
    }

    throw unavailableError();
  },
  watch: (ctx, method, _args, sink) => {
    if (method !== "events") {
      sink.end({ code: "invalid_argument", message: `desktop watch has no "${method}".` });
      return () => undefined;
    }

    const bridge = getDesktopPageAppsBridge();
    const native = getDesktopNativeGlobal();
    const unsubs: Array<() => void> = [];

    const forwardEvent = (event: DesktopPageAppNodeApiEvent) => {
      if (!isRecord(event)) return;
      if (event.appId && event.appId !== ctx.appId) return;
      sink.next(event);
    };

    if (bridge && typeof bridge.onDesktopApiEvent === "function") {
      unsubs.push(bridge.onDesktopApiEvent(forwardEvent));
    } else if (native) {
      const subscribe = native.subscribe ?? native.onEvent;
      if (typeof subscribe === "function") {
        unsubs.push(subscribe(forwardEvent));
      }
    }

    if (unsubs.length === 0) {
      sink.end({ code: "unavailable", message: "Desktop events are unavailable." });
      return () => undefined;
    }

    const cleanup = () => {
      while (unsubs.length > 0) {
        unsubs.pop()?.();
      }
    };
    ctx.signal.addEventListener("abort", cleanup, { once: true });
    return () => {
      ctx.signal.removeEventListener("abort", cleanup);
      cleanup();
    };
  },
};
