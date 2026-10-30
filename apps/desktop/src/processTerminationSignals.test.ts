import { EventEmitter } from "node:events";

import { describe, expect, it, vi } from "vitest";

import { registerDesktopTerminationSignalHandlers } from "./processTerminationSignals";

describe("desktop process termination signals", () => {
  it("runs Moss shutdown before an already-registered Electron SIGTERM listener", async () => {
    const source = new EventEmitter();
    const calls: string[] = [];
    source.on("SIGTERM", () => calls.push("electron"));

    registerDesktopTerminationSignalHandlers({
      ready: Promise.resolve(),
      source,
      isShutdownStarted: () => false,
      onSignal: (signal) => calls.push(`moss:${signal}`),
    });

    await Promise.resolve();
    source.emit("SIGTERM");

    expect(calls).toEqual(["moss:SIGTERM", "electron"]);
  });

  it("handles SIGINT and ignores duplicate signals after shutdown starts", async () => {
    const source = new EventEmitter();
    const onSignal = vi.fn<(signal: "SIGINT" | "SIGTERM") => void>();
    let shutdownStarted = false;

    registerDesktopTerminationSignalHandlers({
      ready: Promise.resolve(),
      source,
      isShutdownStarted: () => shutdownStarted,
      onSignal: (signal) => {
        onSignal(signal);
        shutdownStarted = true;
      },
    });

    await Promise.resolve();
    source.emit("SIGINT");
    source.emit("SIGTERM");

    expect(onSignal).toHaveBeenCalledOnce();
    expect(onSignal).toHaveBeenCalledWith("SIGINT");
  });

  it("removes only the handlers it registered", async () => {
    const source = new EventEmitter();
    const electronHandler = vi.fn();
    const mossHandler = vi.fn();
    source.on("SIGTERM", electronHandler);

    const unregister = registerDesktopTerminationSignalHandlers({
      ready: Promise.resolve(),
      source,
      isShutdownStarted: () => false,
      onSignal: mossHandler,
    });
    await Promise.resolve();
    unregister();
    source.emit("SIGTERM");

    expect(mossHandler).not.toHaveBeenCalled();
    expect(electronHandler).toHaveBeenCalledOnce();
  });

  it("does not register a native watcher until Electron is ready", async () => {
    const source = new EventEmitter();
    let finishReady!: () => void;
    const ready = new Promise<void>((resolve) => {
      finishReady = resolve;
    });
    const onSignal = vi.fn();
    registerDesktopTerminationSignalHandlers({
      ready,
      source,
      isShutdownStarted: () => false,
      onSignal,
    });
    await Promise.resolve();
    expect(source.listenerCount("SIGINT")).toBe(0);
    expect(source.listenerCount("SIGTERM")).toBe(0);
    finishReady();
    await ready;
    expect(source.listenerCount("SIGINT")).toBe(1);
    expect(source.listenerCount("SIGTERM")).toBe(1);
    source.emit("SIGTERM");
    expect(onSignal).toHaveBeenCalledExactlyOnceWith("SIGTERM");
  });

  it("does not register after disposal while readiness is pending", async () => {
    const source = new EventEmitter();
    const unregister = registerDesktopTerminationSignalHandlers({
      ready: Promise.resolve(),
      source,
      isShutdownStarted: () => false,
      onSignal: vi.fn(),
    });
    unregister();
    await Promise.resolve();
    expect(source.eventNames()).toEqual([]);
  });
});
