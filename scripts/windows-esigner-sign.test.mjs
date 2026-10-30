import { assert, describe, it } from "@effect/vitest";
import { createHash } from "node:crypto";
import {
  existsSync,
  linkSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  assertLateSigningTargetUnchangedAfterVerification,
  assertLateSigningTargetUnchangedBeforeSigning,
  captureLateSigningTargetAfterSigning,
  CODE_SIGN_TOOL_JAVA_RELATIVE_PATH,
  CODE_SIGN_TOOL_JAVA_SHA256,
  CODE_SIGN_TOOL_JAR_NAME,
  CODE_SIGN_TOOL_JAR_SHA256,
  createCodeSignToolInvocation,
  createSanitizedChildEnvironment,
  findCodeSignToolErrorMarker,
  resolveTrustedWindowsPowerShell,
  runCodeSignTool,
  runCodeSignToolWithPinnedPayloads,
  shouldSignWithMossPublisher,
  verifyPinnedCodeSignToolFile,
  verifyPinnedCodeSignToolJar,
  verifyPinnedCodeSignToolJava,
  verifyReviewedLateSigningTarget,
  VERIFY_AUTHENTICODE_SCRIPT_PATH,
  WINDOWS_LATE_SIGNING_TARGET_PATHS,
  WINDOWS_POWERSHELL_RELATIVE_PATH,
  WINDOWS_UNPACKED_SIGNING_TARGET_PATHS,
} from "./windows-esigner-sign.mjs";

const expectedPublisher = "CN=Moss Test, O=Moss Test, C=CN";
const expectedThumbprint = "0123456789ABCDEF0123456789ABCDEF01234567";

function signingEnv(toolPath) {
  return {
    CODE_SIGN_TOOL_PATH: toolPath,
    SSL_COM_ES_USERNAME: "release@example.com",
    SSL_COM_ES_PASSWORD: "password with spaces",
    SSL_COM_CREDENTIAL_ID: "credential-id",
    SSL_COM_TOTP_SECRET: "totp-secret",
    SSL_COM_PUBLISHER_NAME: expectedPublisher,
    SSL_COM_CERTIFICATE_THUMBPRINT: expectedThumbprint,
  };
}

function withFixture(run) {
  const root = mkdtempSync(path.join(realpathSync.native(tmpdir()), "moss-esigner-test-"));
  const toolPath = path.join(root, "CodeSignTool-v1.3.0");
  const inputPath = path.join(root, "Moss.exe");
  mkdirSync(path.join(toolPath, "jar"), { recursive: true });
  mkdirSync(path.dirname(path.join(toolPath, CODE_SIGN_TOOL_JAVA_RELATIVE_PATH)), {
    recursive: true,
  });
  writeFileSync(path.join(toolPath, "jar", CODE_SIGN_TOOL_JAR_NAME), "fixture");
  writeFileSync(path.join(toolPath, CODE_SIGN_TOOL_JAVA_RELATIVE_PATH), "fixture");
  writeFileSync(inputPath, "fixture");
  try {
    run({ inputPath, toolPath });
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
}

function sha256(contents) {
  return createHash("sha256").update(contents).digest("hex");
}

describe("createCodeSignToolInvocation", () => {
  it("builds one SHA-256 in-place eSigner invocation without shell interpolation", () => {
    withFixture(({ inputPath, toolPath }) => {
      const invocation = createCodeSignToolInvocation(
        { hash: "sha256", name: "Moss", path: inputPath },
        {
          ...signingEnv(toolPath),
        },
      );

      assert.equal(
        invocation.javaExecutable,
        path.join(toolPath, CODE_SIGN_TOOL_JAVA_RELATIVE_PATH),
      );
      assert.ok(invocation.args.includes(`-input_file_path=${inputPath}`));
      assert.ok(invocation.args.includes("-password=password with spaces"));
      assert.ok(invocation.args.includes("-malware_block=true"));
      assert.ok(invocation.args.includes("-override=true"));
      assert.equal(invocation.args.filter((arg) => arg === "sign").length, 1);
      assert.equal(invocation.expectedPublisher, expectedPublisher);
      assert.equal(invocation.expectedThumbprint, expectedThumbprint);
    });
  });

  it("rejects an unexpected dual-signing pass", () => {
    withFixture(({ inputPath, toolPath }) => {
      assert.throws(
        () =>
          createCodeSignToolInvocation(
            { hash: "sha1", name: "Moss", path: inputPath },
            signingEnv(toolPath),
          ),
        /sha256 pass/,
      );
    });
  });

  it("fails closed when the pinned CodeSignTool payload is absent", () => {
    const root = mkdtempSync(path.join(tmpdir(), "moss-esigner-missing-"));
    const inputPath = path.join(root, "Moss.exe");
    writeFileSync(inputPath, "fixture");
    try {
      assert.throws(
        () =>
          createCodeSignToolInvocation(
            { hash: "sha256", name: "Moss", path: inputPath },
            {
              ...signingEnv(root),
            },
          ),
        /CodeSignTool JAR was not prepared/,
      );
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("rejects a present JAR whose bytes do not match the reviewed SSL.com payload", () => {
    withFixture(({ toolPath }) => {
      assert.equal(CODE_SIGN_TOOL_JAR_SHA256.length, 64);
      assert.throws(
        () => verifyPinnedCodeSignToolJar(path.join(toolPath, "jar", CODE_SIGN_TOOL_JAR_NAME)),
        /JAR SHA-256 does not match/,
      );
    });
  });

  it("rejects a Java runtime whose bytes do not match the reviewed SSL.com payload", () => {
    withFixture(({ toolPath }) => {
      assert.equal(CODE_SIGN_TOOL_JAVA_SHA256.length, 64);
      assert.throws(
        () => verifyPinnedCodeSignToolJava(path.join(toolPath, CODE_SIGN_TOOL_JAVA_RELATIVE_PATH)),
        /Java SHA-256 does not match/,
      );
    });
  });

  it("keeps signer secrets out of Java and PowerShell child environments", () => {
    const childEnv = createSanitizedChildEnvironment({
      PATH: "C:\\Windows\\System32",
      Path: "C:\\attacker-controlled",
      PSModulePath: "C:\\attacker-controlled-modules",
      SystemRoot: "C:\\Windows",
      HTTPS_PROXY: "http://attacker-controlled-proxy.test",
      SSL_COM_ES_PASSWORD: "must-not-propagate",
      SSL_COM_TOTP_SECRET: "must-not-propagate",
      GITHUB_TOKEN: "must-not-propagate",
      MOSS_KEY_E2E_KEY: "must-not-propagate",
    });

    assert.deepStrictEqual(childEnv, { SystemRoot: "C:\\Windows" });
  });

  it("resolves Windows PowerShell only from an absolute, direct SystemRoot path", () => {
    const root = mkdtempSync(path.join(realpathSync.native(tmpdir()), "moss-trusted-powershell-"));
    const executable = path.join(root, WINDOWS_POWERSHELL_RELATIVE_PATH);
    mkdirSync(path.dirname(executable), { recursive: true });
    writeFileSync(executable, "reviewed-powershell");
    try {
      const snapshot = resolveTrustedWindowsPowerShell({ SystemRoot: root });
      assert.equal(snapshot.absolutePath, executable);
      assert.equal(snapshot.realPath, executable);
      assert.throws(
        () => resolveTrustedWindowsPowerShell({ SystemRoot: "relative-windows" }),
        /absolute SystemRoot/,
      );

      rmSync(executable);
      mkdirSync(executable);
      assert.throws(
        () => resolveTrustedWindowsPowerShell({ SystemRoot: root }),
        /must be a regular file/,
      );
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("rejects a PowerShell path redirected through an intermediate symlink", () => {
    if (process.platform === "win32") return;
    const root = mkdtempSync(
      path.join(realpathSync.native(tmpdir()), "moss-symlinked-powershell-"),
    );
    const realSystem32 = path.join(root, "real-System32");
    const executable = path.join(realSystem32, "WindowsPowerShell", "v1.0", "powershell.exe");
    mkdirSync(path.dirname(executable), { recursive: true });
    writeFileSync(executable, "redirected-powershell");
    symlinkSync(realSystem32, path.join(root, "System32"));
    try {
      assert.throws(
        () => resolveTrustedWindowsPowerShell({ SystemRoot: root }),
        /must resolve directly to %SystemRoot%/,
      );
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("treats CodeSignTool text errors as failures even when the process exits zero", () => {
    assert.equal(findCodeSignToolErrorMarker("Signed successfully", ""), undefined);
    assert.equal(
      findCodeSignToolErrorMarker("", "Missing required option: username"),
      "Missing required option",
    );
    assert.equal(findCodeSignToolErrorMarker("Exception while signing", ""), "Exception");
  });

  it("does not propagate secret-bearing spawn arguments when Java cannot start", async () => {
    const secret = "must-never-appear-in-the-error";
    let failure;
    try {
      await runCodeSignTool(
        path.join(tmpdir(), "missing-moss-esigner-java"),
        [`-password=${secret}`, `-totp_secret=${secret}`],
        { env: {} },
      );
    } catch (error) {
      failure = error;
    }

    assert.ok(failure instanceof Error);
    assert.ok(!failure.message.includes(secret));
    assert.ok(!JSON.stringify(failure).includes(secret));
    assert.ok(!Object.hasOwn(failure, "spawnargs"));
  });

  it("keeps pinned-spawn failures free of signer secrets", async () => {
    const root = mkdtempSync(
      path.join(realpathSync.native(tmpdir()), "moss-esigner-failed-pinned-spawn-"),
    );
    const jarPath = path.join(root, "reviewed.jar");
    const javaPath = path.join(root, "java.exe");
    const jarContents = "reviewed-jar";
    const javaContents = "reviewed-but-not-executable-java";
    const secret = "must-never-appear-in-a-pinned-spawn-error";
    writeFileSync(jarPath, jarContents);
    writeFileSync(javaPath, javaContents);
    try {
      const snapshots = {
        jarSnapshot: verifyPinnedCodeSignToolFile(
          jarPath,
          "SSL.com CodeSignTool JAR test fixture",
          sha256(jarContents),
        ),
        javaSnapshot: verifyPinnedCodeSignToolFile(
          javaPath,
          "SSL.com CodeSignTool Java test fixture",
          sha256(javaContents),
        ),
      };
      let failure;
      try {
        await runCodeSignToolWithPinnedPayloads(
          ["-jar", jarPath, `-password=${secret}`, `-totp_secret=${secret}`],
          { env: {} },
          snapshots,
        );
      } catch (error) {
        failure = error;
      }
      assert.ok(failure instanceof Error);
      assert.ok(!failure.message.includes(secret));
      assert.ok(!JSON.stringify(failure).includes(secret));
      assert.ok(!Object.hasOwn(failure, "spawnargs"));
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("binds reviewed JAR and Java identities before and after spawn without leaking bytes", async () => {
    const root = mkdtempSync(path.join(realpathSync.native(tmpdir()), "moss-esigner-identity-"));
    const jarPath = path.join(root, "reviewed.jar");
    const javaPath = process.execPath;
    const markerPath = path.join(root, "spawned.txt");
    const reviewedJar = "reviewed-jar";
    const reviewedJavaSha256 = sha256(readFileSync(javaPath));
    const secretMutation = "must-never-appear-in-an-identity-error";
    const captureSnapshots = () => ({
      jarSnapshot: verifyPinnedCodeSignToolFile(
        jarPath,
        "SSL.com CodeSignTool JAR test fixture",
        sha256(reviewedJar),
      ),
      javaSnapshot: verifyPinnedCodeSignToolFile(
        javaPath,
        "SSL.com CodeSignTool Java test fixture",
        reviewedJavaSha256,
      ),
    });
    writeFileSync(jarPath, reviewedJar);
    try {
      const postSpawnSnapshots = captureSnapshots();
      let postSpawnFailure;
      try {
        await runCodeSignToolWithPinnedPayloads(
          [
            "-e",
            "require('node:fs').writeFileSync(process.argv[2], process.argv[3])",
            "--",
            "-jar",
            jarPath,
            secretMutation,
          ],
          { env: process.env },
          postSpawnSnapshots,
        );
      } catch (error) {
        postSpawnFailure = error;
      }
      assert.ok(postSpawnFailure instanceof Error);
      assert.match(postSpawnFailure.message, /changed identity|SHA-256 does not match/);
      assert.ok(!postSpawnFailure.message.includes(secretMutation));
      assert.ok(!JSON.stringify(postSpawnFailure).includes(secretMutation));

      writeFileSync(jarPath, reviewedJar);
      const preSpawnSnapshots = captureSnapshots();
      writeFileSync(jarPath, secretMutation);
      let preSpawnFailure;
      try {
        await runCodeSignToolWithPinnedPayloads(
          [
            "-e",
            "require('node:fs').writeFileSync(process.argv[3], 'spawned')",
            "--",
            "-jar",
            jarPath,
            markerPath,
          ],
          { env: process.env },
          preSpawnSnapshots,
        );
      } catch (error) {
        preSpawnFailure = error;
      }
      assert.ok(preSpawnFailure instanceof Error);
      assert.ok(!preSpawnFailure.message.includes(secretMutation));
      assert.ok(!JSON.stringify(preSpawnFailure).includes(secretMutation));
      assert.equal(existsSync(markerPath), false);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("drains trailing CodeSignTool output before accepting a zero exit", async () => {
    const trailingMarkerScript = [
      "process.stdout.write('x'.repeat(2 * 1024 * 1024));",
      "process.stderr.write('Exception after buffered output');",
    ].join("");

    let failure;
    try {
      await runCodeSignTool(process.execPath, ["-e", trailingMarkerScript], {
        env: process.env,
      });
    } catch (error) {
      failure = error;
    }
    assert.ok(failure instanceof Error);
    assert.match(failure.message, /error marker: Exception/);
  });

  it("pins signer identity, certificate thumbprint, and timestamp verification", () => {
    const verifier = readFileSync(VERIFY_AUTHENTICODE_SCRIPT_PATH, "utf8");
    assert.ok(verifier.includes("SignatureStatus]::Valid"));
    assert.ok(verifier.includes("Authenticode publisher mismatch"));
    assert.ok(verifier.includes("Authenticode certificate thumbprint mismatch"));
    assert.ok(verifier.includes("exactly 40 hexadecimal characters"));
    assert.ok(verifier.includes("TimeStamperCertificate"));
    assert.ok(
      verifier.includes(
        "Modules\\Microsoft.PowerShell.Security\\Microsoft.PowerShell.Security.psd1",
      ),
    );
    assert.ok(
      verifier.includes("Microsoft.PowerShell.Security\\Get-AuthenticodeSignature -LiteralPath"),
    );

    const signerSource = readFileSync(
      new URL("./windows-esigner-sign.mjs", import.meta.url),
      "utf8",
    );
    assert.ok(signerSource.includes("runProcess(powerShellSnapshot.absolutePath"));
    assert.ok(!signerSource.includes('runProcess(\n    "powershell.exe"'));
  });

  it("hash-pins the NSIS helper that electron-builder injects after afterSign", () => {
    const root = mkdtempSync(path.join(tmpdir(), "moss-late-signing-target-"));
    const helperPath = path.join(root, "win-unpacked", "resources", "elevate.exe");
    mkdirSync(path.dirname(helperPath), { recursive: true });
    writeFileSync(helperPath, "reviewed-helper");
    const reviewedHash = "723fc33d07509357b23d8a3c0b374251fdd9f61f7c33bed2073a1f7540f1ddc9";
    const manifest = {
      windows: {
        x64: {
          lateSigningTargets: [
            {
              path: "resources/elevate.exe",
              sha256: reviewedHash,
              source: "fixture NSIS helper",
            },
          ],
        },
      },
    };
    try {
      const unsignedSnapshot = verifyReviewedLateSigningTarget(
        helperPath,
        { MOSS_WINDOWS_TARGET_ARCH: "x64" },
        manifest,
      );
      assert.ok(unsignedSnapshot);
      assertLateSigningTargetUnchangedBeforeSigning(unsignedSnapshot);
      writeFileSync(helperPath, "mutated-helper");
      assert.throws(
        () => assertLateSigningTargetUnchangedBeforeSigning(unsignedSnapshot),
        /changed identity|changed bytes/,
      );
      assert.throws(
        () =>
          verifyReviewedLateSigningTarget(
            helperPath,
            { MOSS_WINDOWS_TARGET_ARCH: "x64" },
            manifest,
          ),
        /Late Windows signing target SHA-256 mismatch/,
      );

      writeFileSync(helperPath, "reviewed-helper");
      const refreshedUnsignedSnapshot = verifyReviewedLateSigningTarget(
        helperPath,
        { MOSS_WINDOWS_TARGET_ARCH: "x64" },
        manifest,
      );
      writeFileSync(helperPath, "signed-helper-with-authenticode-bytes");
      const signedSnapshot = captureLateSigningTargetAfterSigning(refreshedUnsignedSnapshot);
      assertLateSigningTargetUnchangedAfterVerification(signedSnapshot);
      writeFileSync(helperPath, "post-verification-substitution");
      assert.throws(
        () => assertLateSigningTargetUnchangedAfterVerification(signedSnapshot),
        /changed identity|changed bytes/,
      );

      writeFileSync(helperPath, "reviewed-helper");
      const linkedSource = path.join(root, "linked-elevate.exe");
      writeFileSync(linkedSource, "reviewed-helper");
      rmSync(helperPath);
      linkSync(linkedSource, helperPath);
      assert.throws(
        () =>
          verifyReviewedLateSigningTarget(
            helperPath,
            { MOSS_WINDOWS_TARGET_ARCH: "x64" },
            manifest,
          ),
        /exactly one hard link/,
      );

      rmSync(helperPath);
      writeFileSync(helperPath, "reviewed-helper");
      assert.throws(
        () => verifyReviewedLateSigningTarget(helperPath, {}, manifest),
        /MOSS_WINDOWS_TARGET_ARCH=x64 or arm64/,
      );
      const expandedManifest = structuredClone(manifest);
      expandedManifest.windows.x64.lateSigningTargets.push({
        path: "resources/unreviewed.exe",
        sha256: reviewedHash,
        source: "unreviewed fixture",
      });
      assert.throws(
        () =>
          verifyReviewedLateSigningTarget(
            helperPath,
            { MOSS_WINDOWS_TARGET_ARCH: "x64" },
            expandedManifest,
          ),
        /late signing paths must be exactly/,
      );
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("rejects a late target redirected through a directory symlink", () => {
    if (process.platform === "win32") return;
    const root = mkdtempSync(path.join(tmpdir(), "moss-redirected-late-target-"));
    const appOutDir = path.join(root, "win-unpacked");
    const redirectedResources = path.join(root, "redirected-resources");
    const helperPath = path.join(appOutDir, "resources", "elevate.exe");
    mkdirSync(redirectedResources, { recursive: true });
    mkdirSync(appOutDir, { recursive: true });
    writeFileSync(path.join(redirectedResources, "elevate.exe"), "reviewed-helper");
    symlinkSync(redirectedResources, path.join(appOutDir, "resources"));
    const manifest = {
      windows: {
        x64: {
          lateSigningTargets: [
            {
              path: "resources/elevate.exe",
              sha256: "723fc33d07509357b23d8a3c0b374251fdd9f61f7c33bed2073a1f7540f1ddc9",
              source: "fixture NSIS helper",
            },
          ],
        },
      },
    };
    try {
      assert.throws(
        () =>
          verifyReviewedLateSigningTarget(
            helperPath,
            { MOSS_WINDOWS_TARGET_ARCH: "x64" },
            manifest,
          ),
        /must resolve directly inside win-unpacked/,
      );
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("rechecks the reviewed late target around signing and signature verification", () => {
    const signerSource = readFileSync(
      new URL("./windows-esigner-sign.mjs", import.meta.url),
      "utf8",
    );
    const signBody = signerSource.slice(signerSource.indexOf("export async function sign"));
    const beforeSigning = signBody.indexOf("assertLateSigningTargetUnchangedBeforeSigning");
    const verifyJar = signBody.indexOf("verifyPinnedCodeSignToolJar");
    const verifyJava = signBody.indexOf("verifyPinnedCodeSignToolJava");
    const spawnSigner = signBody.indexOf("await runCodeSignToolWithPinnedPayloads");
    const afterSigning = signBody.indexOf("captureLateSigningTargetAfterSigning");
    const verifySignature = signBody.indexOf("await verifyAuthenticodeSignature");
    const afterVerification = signBody.indexOf("assertLateSigningTargetUnchangedAfterVerification");
    assert.ok(beforeSigning >= 0);
    assert.ok(verifyJar >= 0);
    assert.ok(verifyJava > verifyJar);
    assert.ok(spawnSigner > beforeSigning);
    assert.ok(spawnSigner > verifyJava);
    assert.ok(afterSigning > spawnSigner);
    assert.ok(verifySignature > afterSigning);
    assert.ok(afterVerification > verifySignature);
  });

  it("signs Moss-owned Windows artifacts without overwriting bundled vendor binaries", () => {
    for (const relativePath of [
      ...WINDOWS_UNPACKED_SIGNING_TARGET_PATHS,
      ...WINDOWS_LATE_SIGNING_TARGET_PATHS,
    ]) {
      const ownedPath = `C:\\runner\\work\\release\\win-unpacked\\${relativePath.replaceAll("/", "\\")}`;
      assert.equal(shouldSignWithMossPublisher(ownedPath), true, ownedPath);
    }
    for (const ownedPath of [
      "C:\\runner\\work\\release\\Moss-0.5.4-x64.exe",
      "C:\\runner\\work\\release\\Moss-0.5.4-x64.__uninstaller.exe",
    ]) {
      assert.equal(shouldSignWithMossPublisher(ownedPath), true, ownedPath);
    }

    for (const vendorPath of [
      "C:\\runner\\work\\release\\win-unpacked\\resources\\codex-runtime\\codex.exe",
      "C:\\runner\\work\\release\\win-unpacked\\resources\\claude-runtime\\claude.exe",
      "C:\\runner\\work\\release\\win-unpacked\\resources\\app.asar.unpacked\\node_modules\\node-pty\\winpty-agent.exe",
      "C:\\runner\\work\\release\\win-unpacked\\resources\\Moss-vendor-payload.exe",
      "C:\\runner\\work\\release\\win-unpacked\\resources\\app.asar.unpacked\\addon.node",
      "C:\\runner\\work\\release\\win-unpacked\\resources\\vendor\\resources\\elevate.exe",
      "C:\\runner\\work\\release\\win-unpacked\\evil.dll",
      "C:\\runner\\work\\release\\win-unpacked\\Moss-evil.exe",
      "C:\\runner\\work\\release\\win-unpacked\\resources\\Moss.exe",
      "C:\\runner\\work\\release\\Moss-0.5-x64.exe",
      "C:\\runner\\work\\release\\Moss-0.5.4-x86.exe",
    ]) {
      assert.equal(shouldSignWithMossPublisher(vendorPath), false, vendorPath);
    }
  });

  it("verifies the pinned archive and JAR before configuring or executing either", () => {
    const prepareScript = readFileSync(
      new URL("./prepare-windows-esigner.ps1", import.meta.url),
      "utf8",
    );
    assert.ok(prepareScript.includes("218271514"));
    assert.ok(
      prepareScript.includes("e22094505decbe622afe5b0c27abc618ed2ba179bd94f3450490352399d5ef2a"),
    );
    assert.ok(prepareScript.includes(CODE_SIGN_TOOL_JAR_SHA256));
    assert.ok(prepareScript.includes("272736"));
    assert.ok(prepareScript.includes(CODE_SIGN_TOOL_JAVA_SHA256));
    const download = prepareScript.indexOf("Invoke-WebRequest");
    const verifyArchive = prepareScript.indexOf("Get-FileHash", download);
    const extract = prepareScript.indexOf("Expand-Archive", verifyArchive);
    assert.ok(download >= 0);
    assert.ok(verifyArchive > download);
    assert.ok(extract > verifyArchive);
    const configure = prepareScript.indexOf("WriteAllText", extract);
    const versionProbe = prepareScript.indexOf("--version", configure);
    assert.ok(configure > extract);
    assert.ok(versionProbe > configure);
    assert.ok(prepareScript.includes('"CODE_SIGN_TOOL_PATH=$DestinationPath"'));
    assert.ok(prepareScript.includes("jdk-11.0.2/bin/java.exe"));
    assert.ok(!prepareScript.includes("JAVA_HOME"));
  });
});
