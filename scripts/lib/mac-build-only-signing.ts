// Owns the explicit macOS build-only signing subprocess boundary.
import path from "node:path";
import { ChildProcess } from "effect/unstable/process";
import {
  MAC_APPSNAP_HELPER_BUNDLE_PATH,
  MAC_CANONICAL_FILESYSTEM_HELPER_BUNDLE_PATH,
  MAC_CANONICAL_FILESYSTEM_HELPER_SIGN_MODULE_PATH,
  MAC_ENTITLEMENTS_PATH,
  MAC_INHERITED_ENTITLEMENTS_PATH,
} from "./desktop-platform-build-config.ts";
import { createMacBuildOnlySigningEnvironment } from "./desktop-signing-environment.ts";

export interface MacBuildOnlySignCommandInput {
  readonly executable: string;
  readonly isBun: boolean;
  readonly appBundlePath: string;
  readonly electronVersion: string;
  readonly repoRoot: string;
  readonly env: NodeJS.ProcessEnv;
}

export function createMacBuildOnlySignCommandPlan(input: MacBuildOnlySignCommandInput) {
  return {
    executable: input.executable,
    args: [
      ...(input.isBun ? ["--no-env-file"] : []),
      MAC_CANONICAL_FILESYSTEM_HELPER_SIGN_MODULE_PATH,
      "--build-only",
      input.appBundlePath,
      input.electronVersion,
      path.join(input.repoRoot, MAC_ENTITLEMENTS_PATH),
      path.join(input.repoRoot, MAC_INHERITED_ENTITLEMENTS_PATH),
      path.join(input.appBundlePath, MAC_APPSNAP_HELPER_BUNDLE_PATH),
      path.join(input.appBundlePath, MAC_CANONICAL_FILESYSTEM_HELPER_BUNDLE_PATH),
    ],
    options: {
      cwd: input.repoRoot,
      env: createMacBuildOnlySigningEnvironment(input.env),
      extendEnv: false,
      stdout: "pipe",
      stderr: "pipe",
    } as const,
  };
}

export function createMacBuildOnlySignCommand(input: MacBuildOnlySignCommandInput) {
  const plan = createMacBuildOnlySignCommandPlan(input);
  return ChildProcess.make(plan.executable, plan.args, plan.options);
}
