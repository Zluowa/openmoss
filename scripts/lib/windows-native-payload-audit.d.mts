// FILE: windows-native-payload-audit.d.mts
// Purpose: Types for the part of windows-native-payload-audit.mjs that TypeScript build code calls.

export declare const WINDOWS_AGENT_RUNTIME_RESOURCE_PREFIXES: ReadonlyArray<string>;

export interface WindowsNativeFile {
  readonly absolutePath: string;
  readonly path: string;
  readonly sha256: string;
}

export declare function auditWindowsAgentRuntimePayloads(input: {
  readonly root: string;
  readonly arch: string;
  readonly manifest: unknown;
}): { readonly nativeFiles: ReadonlyArray<WindowsNativeFile> };

export declare function auditWindowsNativePayloads(input: {
  readonly appOutDir: string;
  readonly arch: string;
  readonly manifest: unknown;
  readonly phase: "before-sign" | "after-sign";
  readonly agentRuntimes?: "bundled" | "download";
}): {
  readonly nativeFiles: ReadonlyArray<WindowsNativeFile>;
  readonly preservedPayloads: ReadonlyArray<WindowsNativeFile>;
  readonly signingTargets: ReadonlyArray<WindowsNativeFile>;
};

export declare function resolveWindowsNativePayloadHookContext(
  context: unknown,
  env?: Readonly<Record<string, string | undefined>>,
): { readonly appOutDir: string; readonly arch: string };
