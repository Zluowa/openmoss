// FILE: windows-esigner-sign.mjs
// Purpose: Signs every Windows executable selected by electron-builder through SSL.com eSigner.
// Layer: Release/build hook
// Depends on: A hash-verified CodeSignTool archive and eSigner credentials in env.

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import windowsNativePayloadManifest from "./windows-native-payload-manifest.json" with { type: "json" };

export const CODE_SIGN_TOOL_JAR_NAME = "code_sign_tool-1.3.0.jar";
export const CODE_SIGN_TOOL_JAR_SHA256 =
  "00608c4d1fa3e68b4861a49ee701e6fdba1ff1e41da4ddc61076d845ff23767e";
export const CODE_SIGN_TOOL_JAVA_RELATIVE_PATH = path.join("jdk-11.0.2", "bin", "java.exe");
export const CODE_SIGN_TOOL_JAVA_SHA256 =
  "bb8df03053f4f60ff36ec9df61eadc75bcd551cf94210d96896129b1ab6239a0";
export const CODE_SIGN_TOOL_ERROR_MARKERS = [
  "Error",
  "Exception",
  "Missing required option",
  "Unmatched arguments from",
  "Unmatched argument",
];
export const VERIFY_AUTHENTICODE_SCRIPT_PATH = fileURLToPath(
  new URL("./verify-windows-authenticode.ps1", import.meta.url),
);

const CHILD_ENV_ALLOWLIST = [
  "ALLUSERSPROFILE",
  "APPDATA",
  "ComSpec",
  "HOMEDRIVE",
  "HOMEPATH",
  "LOCALAPPDATA",
  "NUMBER_OF_PROCESSORS",
  "OS",
  "PATHEXT",
  "PROCESSOR_ARCHITECTURE",
  "ProgramData",
  "ProgramFiles",
  "ProgramFiles(x86)",
  "ProgramW6432",
  "PUBLIC",
  "SystemDrive",
  "SystemRoot",
  "TEMP",
  "TMP",
  "USERDOMAIN",
  "USERNAME",
  "USERPROFILE",
  "windir",
];

export const WINDOWS_UNPACKED_SIGNING_TARGET_PATHS = [
  "Moss.exe",
  "d3dcompiler_47.dll",
  "dxcompiler.dll",
  "dxil.dll",
  "ffmpeg.dll",
  "libEGL.dll",
  "libGLESv2.dll",
  "vk_swiftshader.dll",
  "vulkan-1.dll",
];
export const WINDOWS_LATE_SIGNING_TARGET_PATHS = ["resources/elevate.exe"];
export const WINDOWS_POWERSHELL_RELATIVE_PATH = path.join(
  "System32",
  "WindowsPowerShell",
  "v1.0",
  "powershell.exe",
);

const WINDOWS_UNPACKED_SIGNING_TARGET_PATH_KEYS = new Set(
  WINDOWS_UNPACKED_SIGNING_TARGET_PATHS.map((entry) => entry.toLowerCase()),
);
const WINDOWS_LATE_SIGNING_TARGET_PATH_KEYS = new Set(
  WINDOWS_LATE_SIGNING_TARGET_PATHS.map((entry) => entry.toLowerCase()),
);
const WINDOWS_INSTALLER_SIGNING_TARGET =
  /^Moss-\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?-(?:x64|arm64)(?:\.__uninstaller)?\.exe$/i;

export function createSanitizedChildEnvironment(env = process.env) {
  return Object.fromEntries(
    CHILD_ENV_ALLOWLIST.flatMap((key) => (env[key] === undefined ? [] : [[key, env[key]]])),
  );
}

function normalizedPathForComparison(filePath) {
  const normalized = path.normalize(filePath);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function fileStatsSnapshot(fileStats) {
  return {
    ctimeNs: fileStats.ctimeNs,
    dev: fileStats.dev,
    ino: fileStats.ino,
    mode: fileStats.mode,
    mtimeNs: fileStats.mtimeNs,
    nlink: fileStats.nlink,
    size: fileStats.size,
  };
}

function requireAbsoluteRegularFile(
  filePath,
  label,
  { readContents = false, requireSingleLink = false } = {},
) {
  if (typeof filePath !== "string" || !path.isAbsolute(filePath)) {
    throw new Error(`${label} must use an absolute path.`);
  }
  const lstatBeforeOpen = lstatSync(filePath, { bigint: true });
  if (lstatBeforeOpen.isSymbolicLink() || !lstatBeforeOpen.isFile()) {
    throw new Error(`${label} must be a regular file and must not be a symbolic link.`);
  }
  if (requireSingleLink && lstatBeforeOpen.nlink !== 1n) {
    throw new Error(`${label} must have exactly one hard link.`);
  }

  const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
  const descriptor = openSync(filePath, constants.O_RDONLY | noFollow);
  let openedStats;
  let contents;
  try {
    openedStats = fstatSync(descriptor, { bigint: true });
    if (!openedStats.isFile()) {
      throw new Error(`${label} must remain a regular file when opened.`);
    }
    contents = readContents ? readFileSync(descriptor) : undefined;
  } finally {
    closeSync(descriptor);
  }

  const lstatAfterOpen = lstatSync(filePath, { bigint: true });
  const beforeSnapshot = fileStatsSnapshot(lstatBeforeOpen);
  const openedSnapshot = fileStatsSnapshot(openedStats);
  const afterSnapshot = fileStatsSnapshot(lstatAfterOpen);
  const absolutePath = path.resolve(filePath);
  assertSameFileSnapshot(
    { ...beforeSnapshot, absolutePath, realPath: absolutePath },
    { ...openedSnapshot, absolutePath, realPath: absolutePath },
    label,
  );
  assertSameFileSnapshot(
    { ...beforeSnapshot, absolutePath, realPath: absolutePath },
    { ...afterSnapshot, absolutePath, realPath: absolutePath },
    label,
  );
  const realPath = realpathSync.native(filePath);
  const finalSnapshot = fileStatsSnapshot(lstatSync(filePath, { bigint: true }));
  assertSameFileSnapshot(
    { ...afterSnapshot, absolutePath, realPath },
    { ...finalSnapshot, absolutePath, realPath },
    label,
  );

  return {
    ...finalSnapshot,
    absolutePath,
    contents,
    realPath,
  };
}

function describeChangedFile(label) {
  return new Error(`${label} changed identity while the Windows signing gate was running.`);
}

function assertSameFileSnapshot(expected, actual, label, { allowContentMutation = false } = {}) {
  for (const key of ["dev", "ino", "mode", "nlink"]) {
    if (actual[key] !== expected[key]) throw describeChangedFile(label);
  }
  if (
    normalizedPathForComparison(actual.absolutePath) !==
      normalizedPathForComparison(expected.absolutePath) ||
    normalizedPathForComparison(actual.realPath) !== normalizedPathForComparison(expected.realPath)
  ) {
    throw describeChangedFile(label);
  }
  if (
    !allowContentMutation &&
    (actual.size !== expected.size ||
      actual.mtimeNs !== expected.mtimeNs ||
      actual.ctimeNs !== expected.ctimeNs)
  ) {
    throw describeChangedFile(label);
  }
}

function requireDirectAbsoluteRegularFile(filePath, label, options) {
  const snapshot = requireAbsoluteRegularFile(filePath, label, options);
  if (
    normalizedPathForComparison(snapshot.realPath) !==
    normalizedPathForComparison(snapshot.absolutePath)
  ) {
    throw new Error(`${label} must resolve directly to its absolute path.`);
  }
  return snapshot;
}

export function resolveTrustedWindowsPowerShell(env = process.env) {
  const systemRoot = env.SystemRoot?.trim();
  if (!systemRoot || !path.isAbsolute(systemRoot)) {
    throw new Error("Authenticode verification requires an absolute SystemRoot path.");
  }
  const executable = path.join(systemRoot, WINDOWS_POWERSHELL_RELATIVE_PATH);
  const snapshot = requireAbsoluteRegularFile(executable, "Windows PowerShell verifier");
  if (normalizedPathForComparison(snapshot.realPath) !== normalizedPathForComparison(executable)) {
    throw new Error(
      "Windows PowerShell verifier must resolve directly to %SystemRoot%\\System32\\WindowsPowerShell\\v1.0\\powershell.exe.",
    );
  }
  return snapshot;
}

function assertTrustedWindowsPowerShellUnchanged(snapshot) {
  const current = requireAbsoluteRegularFile(snapshot.absolutePath, "Windows PowerShell verifier");
  if (
    normalizedPathForComparison(current.realPath) !==
    normalizedPathForComparison(snapshot.absolutePath)
  ) {
    throw describeChangedFile("Windows PowerShell verifier");
  }
  assertSameFileSnapshot(snapshot, current, "Windows PowerShell verifier");
}

export function verifyPinnedCodeSignToolFile(filePath, label, expectedSha256) {
  if (typeof label !== "string" || !label.trim()) {
    throw new Error("SSL.com CodeSignTool payload verification requires a label.");
  }
  if (!/^[0-9a-f]{64}$/.test(expectedSha256 ?? "")) {
    throw new Error(`${label} reviewed SHA-256 is invalid.`);
  }
  const snapshot = requireDirectAbsoluteRegularFile(filePath, label, {
    readContents: true,
    requireSingleLink: true,
  });
  const { contents, ...fileSnapshot } = snapshot;
  const digest = createHash("sha256").update(contents).digest("hex");
  if (digest !== expectedSha256) {
    throw new Error(`${label} SHA-256 does not match the reviewed payload.`);
  }
  return Object.freeze({
    ...fileSnapshot,
    label,
    sha256: digest,
  });
}

export function assertPinnedCodeSignToolFileUnchanged(snapshot) {
  if (!snapshot || typeof snapshot !== "object") {
    throw new Error("SSL.com CodeSignTool payload identity snapshot is missing.");
  }
  const current = verifyPinnedCodeSignToolFile(
    snapshot.absolutePath,
    snapshot.label,
    snapshot.sha256,
  );
  assertSameFileSnapshot(snapshot, current, snapshot.label);
}

export function verifyPinnedCodeSignToolJar(jarPath) {
  return verifyPinnedCodeSignToolFile(
    jarPath,
    "SSL.com CodeSignTool JAR",
    CODE_SIGN_TOOL_JAR_SHA256,
  );
}

export function verifyPinnedCodeSignToolJava(javaPath) {
  return verifyPinnedCodeSignToolFile(
    javaPath,
    "SSL.com CodeSignTool Java",
    CODE_SIGN_TOOL_JAVA_SHA256,
  );
}

export function shouldSignWithMossPublisher(filePath) {
  if (typeof filePath !== "string" || !filePath.trim()) {
    throw new Error("Windows signing hook received an empty artifact path.");
  }
  const segments = filePath.replaceAll("\\", "/").split("/").filter(Boolean);
  const fileName = segments.at(-1) ?? "";

  const unpackedIndex = segments.findLastIndex(
    (segment) => segment.toLowerCase() === "win-unpacked",
  );
  if (unpackedIndex >= 0) {
    const relativePath = segments.slice(unpackedIndex + 1).join("/");
    if (WINDOWS_UNPACKED_SIGNING_TARGET_PATH_KEYS.has(relativePath.toLowerCase())) {
      return true;
    }
    return WINDOWS_LATE_SIGNING_TARGET_PATH_KEYS.has(relativePath.toLowerCase());
  }
  return WINDOWS_INSTALLER_SIGNING_TARGET.test(fileName);
}

function resolveWinUnpackedRelativePath(filePath) {
  const segments = filePath.replaceAll("\\", "/").split("/").filter(Boolean);
  const unpackedIndex = segments.findLastIndex(
    (segment) => segment.toLowerCase() === "win-unpacked",
  );
  return unpackedIndex < 0 ? undefined : segments.slice(unpackedIndex + 1).join("/");
}

function resolveNativeWinUnpackedTarget(filePath) {
  if (typeof filePath !== "string" || !path.isAbsolute(filePath)) {
    throw new Error("Late Windows signing target must use an absolute path.");
  }
  const absolutePath = path.resolve(filePath);
  let cursor = path.dirname(absolutePath);
  let appOutDir;
  while (true) {
    if (path.basename(cursor).toLowerCase() === "win-unpacked") {
      appOutDir = cursor;
      break;
    }
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  if (!appOutDir) {
    throw new Error("Late Windows signing target must be inside win-unpacked.");
  }

  const relativeNativePath = path.relative(appOutDir, absolutePath);
  if (
    !relativeNativePath ||
    relativeNativePath === ".." ||
    relativeNativePath.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativeNativePath)
  ) {
    throw new Error("Late Windows signing target escaped win-unpacked.");
  }
  return {
    absolutePath,
    appOutDir,
    relativePath: relativeNativePath.split(path.sep).join("/"),
  };
}

function captureLateSigningTargetFile(filePath) {
  const target = resolveNativeWinUnpackedTarget(filePath);
  const snapshot = requireAbsoluteRegularFile(target.absolutePath, "Late Windows signing target", {
    readContents: true,
    requireSingleLink: true,
  });
  const realAppOutDir = realpathSync.native(target.appOutDir);
  const expectedRealPath = path.join(realAppOutDir, ...target.relativePath.split("/"));
  if (
    normalizedPathForComparison(snapshot.realPath) !== normalizedPathForComparison(expectedRealPath)
  ) {
    throw new Error(
      `Late Windows signing target must resolve directly inside win-unpacked: ${target.relativePath}.`,
    );
  }
  const { contents, ...fileSnapshot } = snapshot;
  return {
    ...fileSnapshot,
    appOutDir: target.appOutDir,
    relativePath: target.relativePath,
    sha256: createHash("sha256").update(contents).digest("hex"),
  };
}

export function verifyReviewedLateSigningTarget(
  filePath,
  env = process.env,
  manifest = windowsNativePayloadManifest,
) {
  const relativePath = resolveWinUnpackedRelativePath(filePath);
  if (
    relativePath === undefined ||
    !WINDOWS_LATE_SIGNING_TARGET_PATH_KEYS.has(relativePath.toLowerCase())
  ) {
    return undefined;
  }

  const targetSnapshot = captureLateSigningTargetFile(filePath);
  if (targetSnapshot.relativePath !== relativePath) {
    throw new Error(
      `Late Windows signing target path casing or normalization changed: expected ${relativePath}, got ${targetSnapshot.relativePath}.`,
    );
  }

  const arch = env.MOSS_WINDOWS_TARGET_ARCH?.trim();
  if (arch !== "x64" && arch !== "arm64") {
    throw new Error(
      `Late Windows signing target requires MOSS_WINDOWS_TARGET_ARCH=x64 or arm64, got ${arch || "<missing>"}.`,
    );
  }
  const entries = manifest?.windows?.[arch]?.lateSigningTargets;
  if (!Array.isArray(entries)) {
    throw new Error(
      `Windows native payload manifest has no reviewed ${arch} late signing targets.`,
    );
  }
  const configuredPaths = entries.map((candidate) => candidate?.path);
  if (
    configuredPaths.length !== WINDOWS_LATE_SIGNING_TARGET_PATHS.length ||
    configuredPaths.some(
      (candidate, index) => candidate !== WINDOWS_LATE_SIGNING_TARGET_PATHS[index],
    )
  ) {
    throw new Error(
      `Windows native payload manifest late signing paths must be exactly: ${WINDOWS_LATE_SIGNING_TARGET_PATHS.join(", ")}.`,
    );
  }
  const entry = entries.find(
    (candidate) => candidate?.path?.toLowerCase() === relativePath.toLowerCase(),
  );
  if (!entry) {
    throw new Error(`Unreviewed late Windows signing target: ${relativePath}.`);
  }
  if (entry.path !== relativePath) {
    throw new Error(
      `Late Windows signing target path casing changed: expected ${entry.path}, got ${relativePath}.`,
    );
  }
  if (!/^[0-9a-f]{64}$/.test(entry.sha256 ?? "") || !entry.source?.trim()) {
    throw new Error(`Late Windows signing target provenance is incomplete for ${relativePath}.`);
  }
  if (targetSnapshot.sha256 !== entry.sha256) {
    throw new Error(
      `Late Windows signing target SHA-256 mismatch for ${relativePath}: expected ${entry.sha256}, got ${targetSnapshot.sha256}.`,
    );
  }
  return targetSnapshot;
}

export function assertLateSigningTargetUnchangedBeforeSigning(snapshot) {
  if (!snapshot) return;
  const current = captureLateSigningTargetFile(snapshot.absolutePath);
  assertSameFileSnapshot(snapshot, current, "Late Windows signing target");
  if (current.sha256 !== snapshot.sha256) {
    throw new Error("Late Windows signing target changed bytes before signing.");
  }
}

export function captureLateSigningTargetAfterSigning(snapshot) {
  if (!snapshot) return undefined;
  const current = captureLateSigningTargetFile(snapshot.absolutePath);
  assertSameFileSnapshot(snapshot, current, "Late Windows signing target", {
    allowContentMutation: true,
  });
  return current;
}

export function assertLateSigningTargetUnchangedAfterVerification(snapshot) {
  if (!snapshot) return;
  const current = captureLateSigningTargetFile(snapshot.absolutePath);
  assertSameFileSnapshot(snapshot, current, "Late Windows signing target");
  if (current.sha256 !== snapshot.sha256) {
    throw new Error("Late Windows signing target changed bytes during signature verification.");
  }
}

function requiredEnv(name, env) {
  const value = env[name];
  if (!value?.trim()) {
    throw new Error(`SSL.com eSigner is missing required environment value: ${name}.`);
  }
  return value;
}

export function createCodeSignToolInvocation(configuration, env = process.env) {
  if (configuration.hash !== "sha256") {
    throw new Error(
      `SSL.com eSigner only accepts the configured sha256 pass, received '${configuration.hash}'.`,
    );
  }
  if (!configuration.path || !existsSync(configuration.path)) {
    throw new Error(
      `SSL.com eSigner input file does not exist: ${configuration.path ?? "<empty>"}.`,
    );
  }
  const lateSigningTargetSnapshot = verifyReviewedLateSigningTarget(configuration.path, env);

  const codeSignToolPath = requiredEnv("CODE_SIGN_TOOL_PATH", env);
  const jarPath = path.join(codeSignToolPath, "jar", CODE_SIGN_TOOL_JAR_NAME);
  if (!existsSync(jarPath)) {
    throw new Error(`SSL.com CodeSignTool JAR was not prepared at ${jarPath}.`);
  }

  const javaExecutable = path.join(codeSignToolPath, CODE_SIGN_TOOL_JAVA_RELATIVE_PATH);
  if (!existsSync(javaExecutable)) {
    throw new Error(
      `SSL.com CodeSignTool pinned Java runtime was not prepared at ${javaExecutable}.`,
    );
  }
  const args = [
    "-Xmx1024M",
    "-jar",
    jarPath,
    "sign",
    `-username=${requiredEnv("SSL_COM_ES_USERNAME", env)}`,
    `-password=${requiredEnv("SSL_COM_ES_PASSWORD", env)}`,
    `-credential_id=${requiredEnv("SSL_COM_CREDENTIAL_ID", env)}`,
    `-totp_secret=${requiredEnv("SSL_COM_TOTP_SECRET", env)}`,
    `-program_name=${configuration.name || "Moss"}`,
    `-input_file_path=${configuration.path}`,
    "-malware_block=true",
    "-override=true",
  ];

  return {
    args,
    codeSignToolPath,
    expectedPublisher: requiredEnv("SSL_COM_PUBLISHER_NAME", env),
    expectedThumbprint: requiredEnv("SSL_COM_CERTIFICATE_THUMBPRINT", env),
    javaExecutable,
    lateSigningTargetSnapshot,
  };
}

function runProcess(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, options);
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(
          `${path.basename(command)} failed with ${
            signal ? `signal ${signal}` : `exit code ${code ?? "unknown"}`
          }.`,
        ),
      );
    });
  });
}

export function findCodeSignToolErrorMarker(stdout, stderr) {
  const combinedOutput = `${stdout}\n${stderr}`;
  return CODE_SIGN_TOOL_ERROR_MARKERS.find((marker) => combinedOutput.includes(marker));
}

export function runCodeSignTool(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, stdio: ["ignore", "pipe", "pipe"] });
    const markerTailLength = Math.max(
      ...CODE_SIGN_TOOL_ERROR_MARKERS.map((marker) => marker.length),
    );
    let stdoutTail = "";
    let stderrTail = "";
    let errorMarker;
    let settled = false;
    const settle = (callback) => {
      if (settled) return;
      settled = true;
      callback();
    };
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      const inspected = `${stdoutTail}${chunk}`;
      errorMarker ??= findCodeSignToolErrorMarker(inspected, "");
      stdoutTail = inspected.slice(-markerTailLength);
    });
    child.stderr.on("data", (chunk) => {
      const inspected = `${stderrTail}${chunk}`;
      errorMarker ??= findCodeSignToolErrorMarker("", inspected);
      stderrTail = inspected.slice(-markerTailLength);
    });
    child.once("error", () => {
      // Node's raw spawn error contains a spawnargs property. CodeSignTool
      // credentials live in those arguments, so never propagate that object.
      settle(() => reject(new Error(`${path.basename(command)} could not start.`)));
    });
    // `close` fires only after stdout and stderr have drained. CodeSignTool can
    // exit 0 while reporting failure in its output, so checking on `exit`
    // would leave a race where the final marker arrives after we resolve.
    child.once("close", (code, signal) => {
      if (code !== 0) {
        settle(() =>
          reject(
            new Error(
              `${path.basename(command)} failed with ${
                signal ? `signal ${signal}` : `exit code ${code ?? "unknown"}`
              }.`,
            ),
          ),
        );
        return;
      }

      if (errorMarker) {
        settle(() =>
          reject(new Error(`SSL.com CodeSignTool reported an error marker: ${errorMarker}.`)),
        );
        return;
      }
      settle(resolve);
    });
  });
}

function assertPinnedCodeSignToolPayloadsUnchanged(snapshots) {
  if (!snapshots || typeof snapshots !== "object") {
    throw new Error("SSL.com CodeSignTool verified payload snapshots are missing.");
  }
  assertPinnedCodeSignToolFileUnchanged(snapshots.jarSnapshot);
  assertPinnedCodeSignToolFileUnchanged(snapshots.javaSnapshot);
}

export async function runCodeSignToolWithPinnedPayloads(args, options, snapshots) {
  const jarArgumentIndex = args.indexOf("-jar") + 1;
  if (jarArgumentIndex === 0 || jarArgumentIndex >= args.length) {
    throw new Error("SSL.com CodeSignTool invocation is missing its pinned JAR argument.");
  }
  assertPinnedCodeSignToolPayloadsUnchanged(snapshots);
  const pinnedArgs = [...args];
  pinnedArgs[jarArgumentIndex] = snapshots.jarSnapshot.absolutePath;
  try {
    await runCodeSignTool(snapshots.javaSnapshot.absolutePath, pinnedArgs, options);
  } finally {
    assertPinnedCodeSignToolPayloadsUnchanged(snapshots);
  }
}

export async function verifyAuthenticodeSignature(
  filePath,
  expectedPublisher,
  expectedThumbprint,
  childEnv,
) {
  if (!existsSync(VERIFY_AUTHENTICODE_SCRIPT_PATH)) {
    throw new Error(
      `Authenticode verification script does not exist: ${VERIFY_AUTHENTICODE_SCRIPT_PATH}.`,
    );
  }
  const signedArtifactSnapshot = requireDirectAbsoluteRegularFile(
    filePath,
    "Authenticode input file",
  );

  const verifierArguments = [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-File",
    VERIFY_AUTHENTICODE_SCRIPT_PATH,
    "-FilePath",
    filePath,
    "-ExpectedPublisher",
    expectedPublisher,
    ...(expectedThumbprint ? ["-ExpectedThumbprint", expectedThumbprint] : []),
    "-RequireTimestamp",
  ];
  const powerShellSnapshot = resolveTrustedWindowsPowerShell(childEnv);
  assertTrustedWindowsPowerShellUnchanged(powerShellSnapshot);
  try {
    await runProcess(powerShellSnapshot.absolutePath, verifierArguments, {
      env: childEnv,
      stdio: "inherit",
      windowsHide: true,
    });
  } finally {
    try {
      assertTrustedWindowsPowerShellUnchanged(powerShellSnapshot);
    } finally {
      const currentSignedArtifactSnapshot = requireDirectAbsoluteRegularFile(
        signedArtifactSnapshot.absolutePath,
        "Authenticode input file",
      );
      assertSameFileSnapshot(
        signedArtifactSnapshot,
        currentSignedArtifactSnapshot,
        "Authenticode input file",
      );
    }
  }
}

export async function sign(configuration) {
  if (!shouldSignWithMossPublisher(configuration.path)) {
    console.log(
      `[windows-esigner] Preserving upstream binary without re-signing: ${path.basename(configuration.path)}.`,
    );
    return;
  }

  const invocation = createCodeSignToolInvocation(configuration, process.env);
  const childEnv = createSanitizedChildEnvironment(process.env);
  console.log(`[windows-esigner] Signing ${path.basename(configuration.path)} with SHA-256.`);

  try {
    const pinnedCodeSignToolPayloads = {
      jarSnapshot: verifyPinnedCodeSignToolJar(
        path.join(invocation.codeSignToolPath, "jar", CODE_SIGN_TOOL_JAR_NAME),
      ),
      javaSnapshot: verifyPinnedCodeSignToolJava(invocation.javaExecutable),
    };
    assertLateSigningTargetUnchangedBeforeSigning(invocation.lateSigningTargetSnapshot);
    await runCodeSignToolWithPinnedPayloads(
      invocation.args,
      {
        cwd: invocation.codeSignToolPath,
        env: childEnv,
        windowsHide: true,
      },
      pinnedCodeSignToolPayloads,
    );
    const signedLateSigningTargetSnapshot = captureLateSigningTargetAfterSigning(
      invocation.lateSigningTargetSnapshot,
    );
    try {
      await verifyAuthenticodeSignature(
        configuration.path,
        invocation.expectedPublisher,
        invocation.expectedThumbprint,
        childEnv,
      );
    } finally {
      assertLateSigningTargetUnchangedAfterVerification(signedLateSigningTargetSnapshot);
    }
  } finally {
    rmSync(path.join(invocation.codeSignToolPath, "logs"), { force: true, recursive: true });
  }
}
