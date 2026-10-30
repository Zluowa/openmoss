// Headless macOS fixture: actual clang Mach-O, actual private build-only CLI,
// independent @electron/asar extraction, and a strict outer/nested code seal.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { finished } from "node:stream/promises";
import { fileURLToPath } from "node:url";

import { verifyPackagedAsarIntegrity } from "../lib/mac-asar-integrity.mjs";

assert.equal(process.platform, "darwin");
assert.equal(process.arch, "arm64");
const repo = fileURLToPath(new URL("../../", import.meta.url));
const require = createRequire(new URL("../package.json", import.meta.url));
const asar = require("@electron/asar");
const fromBuilder = createRequire(require.resolve("electron-builder/package.json"));
const plist = fromBuilder("plist");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "moss-asar-real-seal-"));
fs.chmodSync(root, 0o700);
const app = path.join(root, "Moss.app");
const resources = path.join(app, "Contents/Resources");
const input = path.join(root, "input");
const helpers = path.join(app, "Contents/Helpers");
const canonicalHelper = path.join(helpers, "moss-canonical-filesystem-helper");
const appsnapHelper = path.join(helpers, "moss-appsnap-helper");
const env = {
  PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
  LANG: "C",
  HOME: process.env.HOME,
  TMPDIR: process.env.TMPDIR,
  NODE_NO_WARNINGS: "1",
};
const commands = [];
const foreignInputNames = process.argv.includes("--foreign-inputs")
  ? ["linux-platform.node", "windows-platform.node"]
  : [];
function run(command, args, timeout = 30_000) {
  const result = spawnSync(command, args, {
    env,
    encoding: "utf8",
    timeout,
    maxBuffer: 1024 * 1024,
  });
  commands.push({ command, args, status: result.status, error: result.error?.code ?? null });
  assert.equal(result.error, undefined, "fixture command failed to execute");
  assert.equal(result.status, 0, result.stderr || "fixture command failed");
  return result.stdout;
}
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
let passed = false;
try {
  fs.mkdirSync(path.join(app, "Contents/MacOS"), { recursive: true });
  fs.mkdirSync(resources, { recursive: true });
  fs.mkdirSync(helpers, { recursive: true });
  fs.mkdirSync(path.join(input, "native"), { recursive: true });
  const source = path.join(root, "main.c");
  fs.writeFileSync(source, "int moss_fixture(void) { return 42; }\nint main(void) { return 0; }\n");
  const main = path.join(app, "Contents/MacOS/Moss");
  run("/usr/bin/clang", ["-arch", "arm64", source, "-o", main]);
  fs.copyFileSync(main, canonicalHelper);
  fs.copyFileSync(main, appsnapHelper);
  const nativeInput = path.join(input, "native/engine.node");
  run("/usr/bin/clang", ["-arch", "arm64", "-dynamiclib", source, "-o", nativeInput]);
  run("/usr/bin/codesign", [
    "--force",
    "--sign",
    "-",
    "--timestamp=none",
    "--identifier",
    "test.moss.initial.native",
    nativeInput,
  ]);
  fs.writeFileSync(path.join(input, "main.js"), "module.exports = 42;\n");
  fs.writeFileSync(path.join(input, "native/stable.txt"), "must remain exact\n");
  for (const name of foreignInputNames) {
    const bytes = Buffer.alloc(128);
    bytes.write(name.startsWith("linux") ? "\x7fELF" : "MZ", 0, "ascii");
    fs.writeFileSync(path.join(input, "native", name), bytes, { mode: 0o755 });
  }
  const archive = path.join(resources, "app.asar");
  await finished(await asar.createPackageWithOptions(input, archive, { unpackDir: "native" }));
  const header = asar.getRawHeader(archive);
  const info = path.join(app, "Contents/Info.plist");
  fs.writeFileSync(
    info,
    plist.build({
      CFBundleIdentifier: "test.moss.asar.fixture",
      CFBundleName: "Moss",
      CFBundleExecutable: "Moss",
      CFBundlePackageType: "APPL",
      CFBundleInfoDictionaryVersion: "6.0",
      CFBundleShortVersionString: "0.0.1",
      CFBundleVersion: "1",
      ElectronAsarIntegrity: {
        "Resources/app.asar": { algorithm: "SHA256", hash: sha(Buffer.from(header.headerString)) },
      },
    }),
  );
  const helperBytes = fs.readFileSync(canonicalHelper);
  fs.writeFileSync(
    path.join(resources, "moss-canonical-filesystem-helper.build.json"),
    JSON.stringify({
      schemaVersion: 1,
      helper: "moss-canonical-filesystem-helper",
      protocolVersion: 2,
      arch: "arm64",
      architectures: ["arm64"],
      fingerprint: sha(fs.readFileSync(source)),
      sha256: sha(helperBytes),
      size: helperBytes.length,
    }),
  );
  const before = verifyPackagedAsarIntegrity(app);
  const native = `${archive}.unpacked/native/engine.node`;
  const beforeNative = sha(fs.readFileSync(native));
  function foreignSnapshot(name) {
    const file = path.join(`${archive}.unpacked/native`, name);
    const stat = fs.statSync(file, { bigint: true });
    return {
      sha256: sha(fs.readFileSync(file)),
      identity: [
        stat.dev,
        stat.ino,
        stat.mode,
        stat.nlink,
        stat.size,
        stat.mtimeNs,
        stat.ctimeNs,
      ].map(String),
    };
  }
  const beforeForeign = foreignInputNames.map(foreignSnapshot);
  run(
    process.execPath,
    [
      ...(process.versions.bun ? ["--no-env-file"] : []),
      path.join(repo, "scripts/mac-canonical-filesystem-helper-sign.mjs"),
      "--build-only",
      app,
      "43.4.1",
      path.join(repo, "apps/desktop/resources/entitlements.mac.plist"),
      path.join(repo, "apps/desktop/resources/entitlements.mac.inherit.plist"),
      appsnapHelper,
      canonicalHelper,
    ],
    120_000,
  );
  const after = verifyPackagedAsarIntegrity(app);
  const afterNative = sha(fs.readFileSync(native));
  assert.deepEqual(
    foreignInputNames.map(foreignSnapshot),
    beforeForeign,
    "foreign unpacked bytes and full file identities must survive actual signing unchanged",
  );
  assert.notEqual(afterNative, beforeNative, "real nested native signing must change the digest");
  assert.equal(after.payloadSha256, before.payloadSha256);
  assert.notEqual(after.headerSha256, before.headerSha256);
  asar.uncache(archive);
  const independent = asar.getRawHeader(archive);
  const declaration = independent.header.files.native.files["engine.node"];
  assert.equal(declaration.integrity.hash, afterNative);
  assert.equal(declaration.size, fs.statSync(native).size);
  assert.equal(sha(asar.extractFile(archive, "native/engine.node")), afterNative);
  assert.equal(asar.extractFile(archive, "main.js").toString(), "module.exports = 42;\n");
  assert.equal(
    plist.parse(fs.readFileSync(info, "utf8")).ElectronAsarIntegrity["Resources/app.asar"].hash,
    sha(Buffer.from(independent.headerString)),
  );
  run("/usr/bin/codesign", ["--verify", "--deep", "--strict", "--verbose=4", app]);
  run("/usr/bin/codesign", ["--verify", "--strict", "--verbose=4", native]);
  const retained = fs.readFileSync(native);
  fs.appendFileSync(native, "tamper");
  assert.throws(() => verifyPackagedAsarIntegrity(app), /unpacked file hash mismatch/u);
  fs.writeFileSync(native, retained);
  run("/usr/bin/codesign", ["--verify", "--deep", "--strict", "--verbose=4", app]);
  passed = true;
  console.log(
    JSON.stringify({
      schema: "moss.mac.asar.real-seal-fixture.v1",
      passed,
      before,
      after,
      beforeNative,
      afterNative,
      commands,
      independentAsarReadback: true,
      foreignInputsUnchanged: foreignInputNames,
      strictNativeAndOuterSeal: true,
      tamperNegativeControlRejected: true,
      visibleAppLaunches: 0,
      providerRequests: 0,
    }),
  );
} finally {
  if (passed) fs.rmSync(root, { recursive: true, force: true });
  else console.error(`Real seal fixture retained at ${root}`);
}
