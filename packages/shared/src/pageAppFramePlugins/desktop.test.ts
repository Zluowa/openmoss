import { runInNewContext } from "node:vm";
import { webcrypto } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { buildPageAppFrameRuntime } from "../pageAppFrameRuntime";
import { desktopFramePlugin } from "./desktop";

const PARENT = "http://127.0.0.1:6010";

interface Posted {
  readonly protocol: string;
  readonly kind: string;
  readonly id?: number;
  readonly capability?: string;
  readonly method?: string;
  readonly args?: unknown;
}

function bootRuntime(options?: { readonly standalone?: boolean; readonly native?: unknown }) {
  const listeners: ((event: unknown) => void)[] = [];
  const posted: Posted[] = [];
  const parent = options?.standalone
    ? null
    : {
        postMessage: (message: Posted, origin: string) => {
          expect(origin).toBe(PARENT);
          posted.push(structuredClone(message));
        },
      };
  const window: Record<string, unknown> = {
    addEventListener: (type: string, listener: (event: unknown) => void) => {
      if (type === "message") listeners.push(listener);
    },
  };
  window.window = window;
  window.parent = options?.standalone ? window : parent;
  if (options?.native) window.mossDesktop = options.native;

  const context = {
    window,
    document: {
      readyState: "complete",
      documentElement: { scrollHeight: 10 },
      body: { scrollHeight: 10 },
    },
    setTimeout,
    crypto: webcrypto,
    Promise,
    Map,
    Set,
    Object,
    JSON,
    Math,
    Uint8Array,
    Array,
    ArrayBuffer,
    String,
    Number,
    TypeError,
    btoa: (s: string) => Buffer.from(s, "binary").toString("base64"),
    atob: (s: string) => Buffer.from(s, "base64").toString("binary"),
  };
  runInNewContext(buildPageAppFrameRuntime({ parentOrigin: PARENT }), context);
  const moss = window.moss as { use: (name: string) => Promise<Record<string, any> | null> };
  const deliver = (data: unknown, origin = PARENT, source: unknown = parent) => {
    for (const listener of listeners) listener({ data, origin, source });
  };
  return { moss, posted, deliver, window };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("desktop frame plugin", () => {
  it("parses cleanly inside the full runtime bundle", () => {
    const runtime = buildPageAppFrameRuntime({ parentOrigin: PARENT });
    expect(runtime).toContain(JSON.stringify(desktopFramePlugin.name));
    expect(() => new Function(runtime)).not.toThrow();
  });

  it("relays window, os split, app.dock, notification codepoints, permissions, and screen via shell bridge", async () => {
    const { moss, posted, deliver } = bootRuntime();
    deliver({ protocol: "moss-app/1", kind: "init", served: ["desktop"] });
    const desktop = (await moss.use("desktop"))!;
    expect(desktop).not.toBeNull();
    expect(Object.isFrozen(desktop)).toBe(true);

    // app.dock.setProgress and setMenu always resolve false
    await expect(desktop.app.dock.setProgress(0.5)).resolves.toBe(false);
    await expect(desktop.app.dock.setMenu([])).resolves.toBe(false);

    // os.platform / os.arch / os.info
    const platPromise = desktop.os.platform();
    await flush();
    expect(posted.at(-1)!.args).toEqual({ namespace: "os", method: "platform", args: null });
    deliver({
      protocol: "moss-app/1",
      kind: "result",
      id: posted.at(-1)!.id,
      ok: true,
      value: "win32",
    });
    await expect(platPromise).resolves.toBe("win32");

    // notification validates raw <= 2000 and 1..300 Unicode code points (emoji = 1 code point)
    await expect(desktop.notification.show({ body: "   \u0007 " })).rejects.toMatchObject({
      code: "invalid_argument",
    });
    await expect(desktop.notification.show({ body: "a".repeat(2001) })).rejects.toMatchObject({
      code: "invalid_argument",
    });
    await expect(desktop.notification.show({ body: "😀".repeat(301) })).rejects.toMatchObject({
      code: "invalid_argument",
    });

    // 300 emoji code points (600 UTF-16 code units) must succeed
    const emoji300 = "😀".repeat(300);
    const notePromise = desktop.notification.show({ body: ` ${emoji300} ` });
    await flush();
    const call = posted.at(-1)!;
    expect(call).toMatchObject({
      kind: "call",
      capability: "desktop",
      method: "invoke",
      args: { namespace: "notification", method: "show", args: { body: emoji300 } },
    });
    deliver({ protocol: "moss-app/1", kind: "result", id: call.id, ok: true, value: true });
    await expect(notePromise).resolves.toBe(true);

    // permissions.request & permissions.declare
    const permPromise = desktop.permissions.request(["notifications"]);
    await flush();
    const permCall = posted.at(-1)!;
    expect(permCall.args).toEqual({
      namespace: "permissions",
      method: "request",
      args: { names: ["notifications"] },
    });
    deliver({
      protocol: "moss-app/1",
      kind: "result",
      id: permCall.id,
      ok: true,
      value: { notifications: "granted" },
    });
    await expect(permPromise).resolves.toEqual({ notifications: "granted" });
  });

  it("validates Menu limits, tray iconIsTemplate/title-only, and dispatches events via native mossDesktop", async () => {
    let eventListener: ((event: unknown) => void) | null = null;
    const invoked: Array<{ ns: string; method: string; args: unknown }> = [];
    const native = {
      isDesktopApp: true,
      invoke: async (ns: string, method: string, args: unknown) => {
        invoked.push({ ns, method, args });
        if (ns === "globalShortcut" && method === "register") return true;
        if (ns === "Menu" && method === "popup") return "item-pop";
        if (ns === "fs" && method === "readFile") {
          return { base64: Buffer.from([1, 2, 3]).toString("base64") };
        }
        return null;
      },
      subscribe: (fn: (event: unknown) => void) => {
        eventListener = fn;
        return () => {
          eventListener = null;
        };
      },
    };

    const { moss } = bootRuntime({ standalone: true, native });
    const desktop = (await moss.use("desktop"))!;
    expect(desktop).not.toBeNull();
    expect(await moss.use("db")).toBeNull();

    // Menu depth > 4 and role forbidden in setApplicationMenu
    await expect(
      desktop.Menu.setApplicationMenu([{ label: "Quit", role: "quit" }]),
    ).rejects.toMatchObject({ code: "invalid_argument" });
    await expect(
      desktop.Menu.setApplicationMenu([
        {
          label: "1",
          submenu: [
            {
              label: "2",
              submenu: [{ label: "3", submenu: [{ label: "4", submenu: [{ label: "5" }] }] }],
            },
          ],
        },
      ]),
    ).rejects.toMatchObject({ code: "invalid_argument" });

    // Menu click callback dispatch
    const appClick = vi.fn();
    await desktop.Menu.setApplicationMenu([{ id: "m1", label: "Run", click: appClick }]);
    eventListener!({ namespace: "menu", event: "click", targetId: "m1", payload: { id: "m1" } });
    expect(appClick).toHaveBeenCalledTimes(1);

    // Tray accepts title-only and forwards iconIsTemplate
    await desktop.tray.set({ title: "42m", iconIsTemplate: true });
    expect(invoked.at(-1)).toEqual({
      ns: "tray",
      method: "set",
      args: { title: "42m", iconIsTemplate: true, hasClickHandler: false },
    });

    const trayClick = vi.fn();
    const trayMenuClick = vi.fn();
    await desktop.tray.set({
      icon: "data:image/png;base64,AAAA",
      iconIsTemplate: false,
      toolTip: "Moss App",
      click: trayClick,
      menu: [{ id: "tm1", label: "Show", click: trayMenuClick }],
    });
    eventListener!({ namespace: "tray", event: "click", payload: {} });
    eventListener!({ namespace: "tray", event: "menu-click", targetId: "tm1", payload: {} });
    expect(trayClick).toHaveBeenCalledTimes(1);
    expect(trayMenuClick).toHaveBeenCalledTimes(1);

    // globalShortcut callback dispatch
    const onShortcut = vi.fn();
    expect(await desktop.globalShortcut.register("CommandOrControl+Shift+K", onShortcut)).toBe(
      true,
    );
    eventListener!({
      namespace: "globalShortcut",
      event: "triggered",
      targetId: "CommandOrControl+Shift+K",
      payload: {},
    });
    expect(onShortcut).toHaveBeenCalledWith("CommandOrControl+Shift+K");

    // fs binary read/write round-trip
    await desktop.fs.writeFile("/tmp/test.bin", new Uint8Array([4, 5, 6]));
    const writeCall = invoked.find((c) => c.ns === "fs" && c.method === "writeFile")!;
    expect(writeCall.args).toMatchObject({
      path: "/tmp/test.bin",
      encoding: "base64",
      base64: Buffer.from([4, 5, 6]).toString("base64"),
    });
    const readBytes = await desktop.fs.readFile("/tmp/test.bin");
    expect(readBytes).toEqual(new Uint8Array([1, 2, 3]));
  });

  it("buffers early spawn/pty events in backlog and forwards env/input/end/endStdin", async () => {
    let eventListener: ((event: unknown) => void) | null = null;
    const invoked: Array<{ ns: string; method: string; args: unknown }> = [];
    const native = {
      invoke: async (ns: string, method: string, args: unknown) => {
        invoked.push({ ns, method, args });
        if (ns === "childProcess" && method === "spawn") {
          const clientId = (args as { clientId: string }).clientId;
          // Emit early packet before caller attaches stdout.on("data")
          eventListener?.({
            namespace: "childProcess",
            event: "stdout",
            targetId: clientId,
            payload: { data: "early-chunk" },
          });
          return { id: clientId, pid: 4242 };
        }
        if (ns === "pty" && method === "spawn") {
          const clientId = (args as { clientId: string }).clientId;
          eventListener?.({
            namespace: "pty",
            event: "data",
            targetId: clientId,
            payload: { data: "early-pty" },
          });
          return { id: clientId, pid: 5252 };
        }
        return null;
      },
      subscribe: (fn: (event: unknown) => void) => {
        eventListener = fn;
        return () => {};
      },
    };

    const { moss } = bootRuntime({ standalone: true, native });
    const desktop = (await moss.use("desktop"))!;

    await desktop.childProcess.exec("echo hi", { env: { FOO: "bar" }, input: "stdin-val" });
    expect(invoked.at(-1)).toEqual({
      ns: "childProcess",
      method: "exec",
      args: { command: "echo hi", options: { env: { FOO: "bar" }, input: "stdin-val" } },
    });

    const proc = desktop.childProcess.spawn("node", ["-v"], { cwd: "/tmp", env: { A: "1" } });
    await proc.ready;
    // Attach listener AFTER ready/early chunk to verify backlog delivery
    const chunks: string[] = [];
    proc.stdout.on("data", (d: string) => chunks.push(d));
    expect(chunks).toEqual(["early-chunk"]);

    await proc.stdin.end();
    await proc.stdin.endStdin();
    expect(invoked.filter((c) => c.ns === "childProcess" && c.method === "endStdin")).toHaveLength(
      2,
    );

    const term = await desktop.pty.spawn("pwsh", [], { cols: 80, rows: 24, env: { B: "2" } });
    await term.ready;
    const ptyOut: string[] = [];
    const sub = term.onData((data: string) => ptyOut.push(data));
    expect(ptyOut).toEqual(["early-pty"]);
    sub.dispose();
  });
});
