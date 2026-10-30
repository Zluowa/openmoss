// FILE: windows-native-payload-after-sign.mjs
// Purpose: electron-builder hook that re-audits vendor bytes and verifies every Moss signature.

import manifest from "./windows-native-payload-manifest.json" with { type: "json" };
import {
  auditWindowsNativePayloads,
  resolveWindowsNativePayloadHookContext,
} from "./lib/windows-native-payload-audit.mjs";
import {
  createSanitizedChildEnvironment,
  verifyAuthenticodeSignature,
} from "./windows-esigner-sign.mjs";

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Windows native signature audit is missing ${name}.`);
  return value;
}

export default async function windowsNativePayloadAfterSign(context) {
  const { appOutDir, arch } = resolveWindowsNativePayloadHookContext(context);
  if (process.env.MOSS_WINDOWS_SIGNED_BUILD !== "1") {
    throw new Error("Windows after-sign audit may run only for an explicitly signed build.");
  }

  const provider = required("WINDOWS_SIGNING_PROVIDER");
  if (provider !== "sslcom") {
    throw new Error(`Unsupported Windows signing provider '${provider}'. Expected sslcom.`);
  }
  const expectedPublisher = required("SSL_COM_PUBLISHER_NAME");
  const expectedThumbprint = required("SSL_COM_CERTIFICATE_THUMBPRINT");
  const result = auditWindowsNativePayloads({
    appOutDir,
    arch,
    manifest,
    phase: "after-sign",
  });
  const childEnv = createSanitizedChildEnvironment(process.env);
  for (const file of result.signingTargets) {
    await verifyAuthenticodeSignature(
      file.absolutePath,
      expectedPublisher,
      expectedThumbprint,
      childEnv,
    );
  }
  console.log(
    `[windows-native-audit] Verified ${result.signingTargets.length} Moss signatures and rechecked ${result.preservedPayloads.length} preserved payload hashes.`,
  );
}
