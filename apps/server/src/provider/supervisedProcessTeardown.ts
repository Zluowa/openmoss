// Compatibility boundary for provider adapters while ownership lives in the
// shared platform runtime. Keep the server module's observer factory in the
// call path so existing server tests and integrations can inject the Windows
// snapshot observer through this historical import.
import * as serverWindowsSnapshot from "../platform/windowsProcessSnapshot.ts";
import {
  teardownProviderProcessTree as sharedTeardownProviderProcessTree,
  type SupervisedProcessTeardownDependencies,
  type SupervisedProcessTeardownInput,
  type SupervisedProcessTeardownResult,
} from "@moss/shared/supervisedProcessTeardown";

export * from "@moss/shared/supervisedProcessTeardown";

export function teardownProviderProcessTree(
  input: SupervisedProcessTeardownInput,
  dependencies: Partial<SupervisedProcessTeardownDependencies> = {},
): Promise<SupervisedProcessTeardownResult> {
  const ownsObserver =
    dependencies.windowsSnapshotObserver === undefined &&
    (dependencies.platform ?? process.platform) === "win32" &&
    dependencies.captureProcessTree === undefined &&
    dependencies.inspectProcessTree === undefined &&
    dependencies.processTreeKiller === undefined;
  const observer = ownsObserver
    ? serverWindowsSnapshot.createWindowsTeardownProcessSnapshotObserver()
    : dependencies.windowsSnapshotObserver;
  const teardown = sharedTeardownProviderProcessTree(
    input,
    observer === undefined ? dependencies : { ...dependencies, windowsSnapshotObserver: observer },
  );
  if (!ownsObserver || observer === undefined) return teardown;
  return teardown.finally(() => observer.dispose());
}
