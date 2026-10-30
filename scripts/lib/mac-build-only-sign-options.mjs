// Fixed signing policy for the private build-only CLI.
import path from "node:path";

function requireBuildOnlyAbsolutePath(value, label) {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.includes("\0") ||
    !path.isAbsolute(value)
  ) {
    throw new Error("Build-only signing requires an absolute " + label + " path.");
  }
  return path.resolve(value);
}

export function parseMacBuildOnlySignArgs(argv) {
  if (argv.length !== 7 || argv[0] !== "--build-only") {
    throw new Error(
      "Expected --build-only APP ELECTRON_VERSION ENTITLEMENTS INHERIT_ENTITLEMENTS APPSNAP_HELPER CANONICAL_HELPER.",
    );
  }
  return {
    app: argv[1],
    version: argv[2],
    entitlements: argv[3],
    entitlementsInherit: argv[4],
    binaries: [argv[5], argv[6]],
  };
}

export function createMacBuildOnlySignOptions(input, canonicalHelperRelativePath) {
  const app = requireBuildOnlyAbsolutePath(input.app, "application");
  if (path.extname(app) !== ".app") {
    throw new Error("Build-only signing requires an .app bundle.");
  }
  if (
    typeof input.version !== "string" ||
    !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u.test(input.version)
  ) {
    throw new Error("Build-only signing requires the explicit Electron version.");
  }
  const entitlements = requireBuildOnlyAbsolutePath(input.entitlements, "entitlements");
  const entitlementsInherit = requireBuildOnlyAbsolutePath(
    input.entitlementsInherit,
    "inherited entitlements",
  );
  if (!Array.isArray(input.binaries) || input.binaries.length !== 2) {
    throw new Error("Build-only signing requires both packaged native helpers.");
  }
  const binaries = input.binaries.map((binary) => requireBuildOnlyAbsolutePath(binary, "helper"));
  for (const binary of binaries) {
    const relative = path.relative(app, binary);
    if (
      !relative ||
      relative === ".." ||
      relative.startsWith(".." + path.sep) ||
      path.isAbsolute(relative)
    ) {
      throw new Error("Build-only helper signing must stay inside the application bundle.");
    }
  }
  if (
    new Set(binaries).size !== 2 ||
    !binaries.includes(path.join(app, canonicalHelperRelativePath))
  ) {
    throw new Error("Build-only signing requires distinct helpers and the canonical helper.");
  }
  return {
    app,
    platform: "darwin",
    type: "distribution",
    version: input.version,
    identity: "-",
    identityValidation: false,
    preEmbedProvisioningProfile: false,
    preAutoEntitlements: false,
    strictVerify: true,
    binaries,
    optionsForFile(filePath) {
      return {
        entitlements: path.resolve(filePath) === app ? entitlements : entitlementsInherit,
        hardenedRuntime: false,
        timestamp: "none",
      };
    },
  };
}
