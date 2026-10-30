import { app, session } from "electron";
import { access } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createMossCanvasTransport, type MossCanvasEndpoint } from "./mossCanvasTransport";

interface CanvasRuntime {
  open(): Promise<boolean>;
  shutdown(): Promise<void>;
}

/** The backend runs in Node mode and cannot infer Electron's resourcesPath. */
export function resolveBundledMossCanvasRoot(): string {
  return app.isPackaged
    ? join(process.resourcesPath, "moss-canvas")
    : join(app.getAppPath(), "canvas-bundle");
}

export function createBundledMossCanvas(endpoint: () => MossCanvasEndpoint) {
  let runtime: Promise<CanvasRuntime> | null = null;
  const load = async (): Promise<CanvasRuntime> => {
    const root = resolveBundledMossCanvasRoot();
    const appRoot = join(root, "apps", "codex-canvas");
    await access(join(appRoot, "dist", "index.html"));
    const moduleUrl = pathToFileURL(join(appRoot, "electron", "desktop-runtime.mjs")).href;
    const canvas = await import(moduleUrl);
    const stateDirectory = join(app.getPath("userData"), "canvas");
    const transport = createMossCanvasTransport({ endpoint });
    // Development may point the hosted window at the canvas Vite dev server
    // (the production tldraw license check does not apply on localhost).
    // Packaged builds always load the bundled hoola-local renderer.
    const devUrl = app.isPackaged ? "" : String(process.env.MOSS_CANVAS_DEV_URL ?? "").trim();
    return canvas.createMossCanvasRuntime({
      appRoot,
      stateDirectory,
      projectDirectory: join(stateDirectory, "workspace"),
      codexHome: join(stateDirectory, "agent"),
      session: session.fromPartition("persist:moss-canvas"),
      ...(devUrl ? { devUrl } : {}),
      ...transport,
    }) as CanvasRuntime;
  };
  return {
    async open(): Promise<boolean> {
      runtime ??= load().catch((error) => {
        runtime = null;
        throw error;
      });
      return (await runtime).open();
    },
    async shutdown(): Promise<void> {
      if (runtime) await (await runtime).shutdown();
    },
  };
}
