// FILE: windows-native-payload-after-pack.mjs
// Purpose: electron-builder hook that audits native Windows payload provenance before signing.

import manifest from "./windows-native-payload-manifest.json" with { type: "json" };
import {
  auditWindowsNativePayloads,
  resolveWindowsNativePayloadHookContext,
} from "./lib/windows-native-payload-audit.mjs";

export default async function windowsNativePayloadAfterPack(context) {
  const { appOutDir, arch } = resolveWindowsNativePayloadHookContext(context);
  const result = auditWindowsNativePayloads({
    appOutDir,
    arch,
    manifest,
    phase: "before-sign",
  });
  console.log(
    `[windows-native-audit] Approved ${result.signingTargets.length} signing targets and ${result.preservedPayloads.length} byte-pinned preserved payloads before signing.`,
  );
}
