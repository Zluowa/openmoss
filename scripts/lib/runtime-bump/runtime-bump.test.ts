import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";
import { gzipSync } from "node:zlib";

import { afterEach, describe, expect, it } from "vitest";

import {
  bunLockPackageEntry,
  findBunLockPackageEntry,
  replaceBunLockPackageEntry,
  replaceBunLockWorkspaceSpec,
  type NpmVersionDocument,
} from "./bun-lock.ts";
import {
  isLicenseFileName,
  parseCargoLock,
  parseGitSource,
  readCargoManifestLicense,
  readWorkspacePackageLicense,
} from "./cargo.ts";
import { addChangelogLine, replaceVersionLiterals, updateWindowsNativeManifest } from "./shared.ts";
import { isApprovedSelection, selectPermissiveLicense } from "./spdx.ts";
import { createTarParser, type TarEntryHeader } from "./tar.ts";
import { indexRepoArchive, resolveCrateLicense } from "./repo-archive.ts";
import { readCrateSourceProvenance } from "./crate-source.ts";
import { readCrateSourceHeaderNotices } from "./source-notices.ts";
import {
  readReviewedCrateNotices,
  selectReviewedCrateLicense,
  type ReviewedBinaryDistribution,
} from "./reviewed-notices.ts";

const REPO_ROOT = Path.resolve(import.meta.dirname, "../../..");
const tempDirs: string[] = [];
afterEach(() => {
  for (const directory of tempDirs.splice(0))
    FS.rmSync(directory, { recursive: true, force: true });
});
function makeTempDir(): string {
  const directory = FS.mkdtempSync(Path.join(OS.tmpdir(), "moss-runtime-bump-"));
  tempDirs.push(directory);
  return directory;
}

describe("SPDX license selection", () => {
  it.each([
    ["MIT OR Apache-2.0", "MIT"],
    ["Apache-2.0 OR MIT", "MIT"],
    ["MIT/Apache-2.0", "MIT"],
    ["Apache-2.0 / MIT", "MIT"],
    ["(MIT OR Apache-2.0) AND Unicode-3.0", "MIT AND Unicode-3.0"],
    ["Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT", "MIT"],
    ["Apache-2.0 WITH LLVM-exception", "Apache-2.0 WITH LLVM-exception"],
    ["GPL-2.0-or-later OR MIT", "MIT"],
    ["Unlicense OR MIT", "MIT"],
    ["MPL-2.0", "MPL-2.0"],
    ["MIT AND MIT", "MIT"],
  ])("selects %s -> %s", (expression, selected) => {
    expect(selectPermissiveLicense(expression)).toBe(selected);
    expect(isApprovedSelection(selected)).toBe(true);
  });

  it("refuses expressions with no permissive branch", () => {
    expect(selectPermissiveLicense("GPL-3.0-only")).toBeNull();
    expect(selectPermissiveLicense("MIT AND GPL-2.0-only")).toBeNull();
    expect(selectPermissiveLicense("Apache-2.0 WITH Classpath-exception-2.0")).toBeNull();
    expect(isApprovedSelection("MIT OR Apache-2.0")).toBe(false);
    expect(isApprovedSelection("GPL-3.0-only")).toBe(false);
    expect(() => selectPermissiveLicense("(MIT")).toThrow(/Unbalanced|Incomplete/);
  });
});

describe("Cargo metadata without cargo", () => {
  it("reads Cargo.lock registry, git and workspace packages", () => {
    const lock = parseCargoLock(`version = 4

[[package]]
name = "codex-core"
version = "0.166.0"
dependencies = [
 "serde",
]

[[package]]
name = "serde"
version = "1.0.228"
source = "registry+https://github.com/rust-lang/crates.io-index"
checksum = "${"a".repeat(64)}"

[[package]]
name = "nucleo"
version = "0.5.0"
source = "git+https://github.com/helix-editor/nucleo.git?rev=4253de9#${"b".repeat(40)}"
`);
    expect(lock).toEqual([
      { name: "codex-core", version: "0.166.0" },
      {
        name: "serde",
        version: "1.0.228",
        source: "registry+https://github.com/rust-lang/crates.io-index",
        checksum: "a".repeat(64),
      },
      {
        name: "nucleo",
        version: "0.5.0",
        source: `git+https://github.com/helix-editor/nucleo.git?rev=4253de9#${"b".repeat(40)}`,
      },
    ]);
    expect(parseGitSource(lock[2]!.source!)).toEqual({
      owner: "helix-editor",
      repo: "nucleo",
      commit: "b".repeat(40),
    });
    expect(() => parseGitSource("git+https://gitlab.com/a/b#" + "c".repeat(40))).toThrow(/GitHub/);
  });

  it("reads license fields, including workspace inheritance", () => {
    expect(
      readCargoManifestLicense(`[package]
name = "serde"
version = "1.0.228"
license = "MIT OR Apache-2.0"
license-file = "LICENSE-MIT"

[dependencies]
license = "not this"
`),
    ).toEqual({
      name: "serde",
      version: "1.0.228",
      license: "MIT OR Apache-2.0",
      licenseFile: "LICENSE-MIT",
      licenseFromWorkspace: false,
      licenseFileFromWorkspace: false,
    });
    expect(
      readCargoManifestLicense(`[package]
name = "codex-core"
license.workspace = true
`).licenseFromWorkspace,
    ).toBe(true);
    expect(
      readCargoManifestLicense(`[package]
name = "codex-tui"
license = { workspace = true }
`).licenseFromWorkspace,
    ).toBe(true);
    expect(
      readCargoManifestLicense(`[package]
name = "codex-app-server"
license.workspace = true

[[bin]]
name = "codex-app-server-test-notify-capture"
`),
    ).toMatchObject({ name: "codex-app-server", licenseFromWorkspace: true });
    expect(
      readCargoManifestLicense(`[package]
name = "ripgrep"
description = """
license = "GPL-3.0-only" inside a description is not a field
"""
license = "Unlicense OR MIT"
`).license,
    ).toBe("Unlicense OR MIT");
    expect(readWorkspacePackageLicense(`[workspace.package]\nlicense = "Apache-2.0"\n`)).toEqual({
      license: "Apache-2.0",
    });
  });

  it("recognises license file names crates ship", () => {
    for (const name of [
      "LICENSE",
      "LICENSE-MIT",
      "LICENSE-APACHE",
      "LICENSE.md",
      "license.txt",
      "LICENCE",
      "COPYING",
      "UNLICENSE",
      "NOTICE",
      "COPYRIGHT",
      "MIT-LICENSE",
      "LICENSE-ZLIB.md",
    ]) {
      expect(isLicenseFileName(name), name).toBe(true);
    }
    for (const name of ["license.rs", "src", "README.md", "licensing.rs", "Cargo.toml"]) {
      expect(isLicenseFileName(name), name).toBe(false);
    }
  });
});

function tarHeader(input: { path: string; size: number; type?: string | undefined }): Buffer {
  const block = Buffer.alloc(512);
  block.write(input.path, 0, 100, "utf8");
  block.write("0000644\0", 100, "ascii");
  block.write("0000000\0", 108, "ascii");
  block.write("0000000\0", 116, "ascii");
  block.write(`${input.size.toString(8).padStart(11, "0")}\0`, 124, "ascii");
  block.write("00000000000\0", 136, "ascii");
  block.write(input.type ?? "0", 156, "ascii");
  block.write("ustar\0", 257, "ascii");
  block.write("00", 263, "ascii");
  block.fill(0x20, 148, 156);
  let sum = 0;
  for (const byte of block) sum += byte;
  block.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, "ascii");
  return block;
}

function tarEntry(path: string, body: Buffer, type?: string): Buffer {
  const padding = Buffer.alloc((512 - (body.length % 512)) % 512);
  return Buffer.concat([tarHeader({ path, size: body.length, type }), body, padding]);
}

describe("declared Cargo license files", () => {
  async function fixture(licensePath: string, includeText: boolean) {
    const file = Path.join(makeTempDir(), "crate.tar.gz");
    FS.writeFileSync(
      file,
      gzipSync(
        Buffer.concat([
          ...(includeText
            ? [
                tarEntry(
                  "package/legal/terms.txt",
                  Buffer.from("Copyright Example Authors\nActual license text"),
                ),
              ]
            : []),
          tarEntry(
            "package/Cargo.toml",
            Buffer.from(
              `[package]\nname = "example"\nversion = "1.0.0"\nlicense = "MIT"\nlicense-file = "${licensePath}"\n`,
            ),
          ),
          Buffer.alloc(1024),
        ]),
      ),
    );
    return indexRepoArchive(file, { label: "example" });
  }

  it("reads a nonstandard explicit filename even when it precedes the manifest", async () => {
    const index = await fixture("legal/terms.txt", true);
    const resolved = resolveCrateLicense(index, "", {
      includeNested: true,
      fallbackToAncestors: true,
    });
    expect(resolved.licenseFiles).toEqual(["legal/terms.txt"]);
    expect(index.extras.get("legal/terms.txt")?.toString()).toContain("Copyright Example Authors");
  });

  it.each(["legal/missing.txt", "../../outside.txt"])(
    "refuses unavailable explicit license-file %s",
    async (licensePath) => {
      const index = await fixture(licensePath, false);
      expect(() =>
        resolveCrateLicense(index, "", { includeNested: true, fallbackToAncestors: true }),
      ).toThrow(/declared license-file/);
    },
  );
});

describe("crate source notice provenance", () => {
  function source(
    input: {
      repository?: string;
      homepage?: string;
      commit?: string;
      dirty?: boolean;
      directory?: string | null;
    } = {},
  ) {
    return readCrateSourceProvenance({
      root: "example-1.0.0",
      manifests: new Map([
        [
          "",
          `[package]\nname = "example"\nrepository = "${input.repository ?? "https://github.com/example/repo.git"}"\nhomepage = "${input.homepage ?? ""}"\n`,
        ],
      ]),
      licenseFiles: new Map(),
      extras: new Map([
        [
          ".cargo_vcs_info.json",
          Buffer.from(
            JSON.stringify({
              git: { sha1: input.commit ?? "a".repeat(40), dirty: input.dirty ?? false },
              ...(input.directory === null
                ? {}
                : { path_in_vcs: input.directory ?? "crates/example" }),
            }),
          ),
        ],
      ]),
    });
  }
  it("binds missing notices to the crate's exact clean GitHub source", () => {
    expect(source()).toEqual({
      source: `git+https://github.com/example/repo#${"a".repeat(40)}`,
      directory: "crates/example",
    });
  });
  it("uses the checked commit when repository metadata points at a moving web directory", () => {
    expect(
      source({ repository: "https://github.com/example/repo/tree/main/crates/example" })?.source,
    ).toBe(`git+https://github.com/example/repo#${"a".repeat(40)}`);
  });
  it("does not invent a root directory for older Cargo VCS metadata", () => {
    expect(source({ directory: null })).toEqual({
      source: `git+https://github.com/example/repo#${"a".repeat(40)}`,
    });
    expect(source({ directory: "" })?.directory).toBe("");
  });
  it("can bind a repository homepage only when the checked archive also supplies an exact commit", () => {
    expect(
      source({
        repository: "",
        homepage: "https://github.com/example/repo/tree/dev/crates/example",
      })?.source,
    ).toBe(`git+https://github.com/example/repo#${"a".repeat(40)}`);
    expect(source({ repository: "", homepage: "https://example.org/project" })).toBeNull();
  });
  it("requires the reviewed archive digest for an older release without VCS metadata", () => {
    const index = {
      root: "difflib-0.4.0",
      manifests: new Map<string, string>(),
      licenseFiles: new Map<string, Buffer>(),
      extras: new Map<string, Buffer>(),
    };
    expect(readCrateSourceProvenance(index)).toBeNull();
    expect(readCrateSourceProvenance(index, "0".repeat(64))).toBeNull();
    expect(
      readCrateSourceProvenance(
        index,
        "6184e33543162437515c2e2b48714794e37845ec9851711914eec9d308f6ebe8",
      ),
    ).toEqual({
      source: "git+https://github.com/DimaKudosh/difflib#f035fb8e656f27119e23eca9d5b996df14f3885e",
      directory: "",
    });
  });
  it.each([
    { repository: "https://example.com/example/repo" },
    { repository: "https://github.com/example/repo/issues/1" },
    { repository: "https://github.com@example.com/example/repo" },
    { repository: "https://github.com/example/repo?ref=main" },
    { commit: "main" },
    { dirty: true },
    { directory: "../other" },
    { directory: "/absolute" },
  ])("refuses unbound or ambiguous provenance %o", (input) => expect(source(input)).toBeNull());
});

describe("REUSE license archive indexing", () => {
  it("preserves SPDX-named license texts from a REUSE LICENSES directory", async () => {
    const file = Path.join(makeTempDir(), "reuse.tar.gz");
    FS.writeFileSync(
      file,
      gzipSync(
        Buffer.concat([
          tarEntry(
            "package/Cargo.toml",
            Buffer.from('[package]\nname = "example"\nversion = "1.0.0"\nlicense = "MIT"\n'),
          ),
          tarEntry(
            "package/LICENSES/MIT.txt",
            Buffer.from("Copyright Original Authors\nPermission is hereby granted"),
          ),
          Buffer.alloc(1024),
        ]),
      ),
    );
    const index = await indexRepoArchive(file, { label: "REUSE example" });
    expect(
      resolveCrateLicense(index, "", { includeNested: false, fallbackToAncestors: true })
        .licenseFiles,
    ).toEqual(["LICENSES/MIT.txt"]);
    expect(index.licenseFiles.get("LICENSES/MIT.txt")?.toString()).toContain(
      "Copyright Original Authors",
    );
  });
});

describe("reviewed omitted notices", () => {
  const binaryDistribution: ReviewedBinaryDistribution = {
    sourceCommit: "6ff1e1ca3b30fc8b914720681fcf5fe62e95f856",
    sourceSha256: "1e33229b8b63237f666d62ba1476134383400d66032cdfde10b7f79debd15d28",
    payloadArchives: [
      {
        id: "launcher",
        sha256: "67ee6f4069d9328956401f54ac202c20369233159058af9f4ec1af731b87f5b7",
      },
      {
        id: "darwin-arm64",
        sha256: "181d2eda8addbeca0b689c996df207293947928bdd9c88a097837ae1c7e69ca5",
      },
      {
        id: "darwin-x64",
        sha256: "588aad29a4779badc894daeb2e43757ed01d213366fd931fd9a5ec47f7e31e14",
      },
      {
        id: "linux-arm64",
        sha256: "9044e840397864fc6c539d13719b25fb26abb35d5353366cbabf7b4555406acd",
      },
      {
        id: "linux-x64",
        sha256: "cbc00a26d3d0e2ceefc4be8891f8a81ef1e349b3b175bc0ae308762bc001fd93",
      },
      {
        id: "win32-arm64",
        sha256: "0af3dbf9675d199026e75d0c01ccbd231ece959ec0ff8207a5db8b4d625e0d00",
      },
      {
        id: "win32-x64",
        sha256: "47d74aed875a3c01315f042152329ae09b0bd9d26a3285802d1c85aeadce083e",
      },
    ],
  };
  it("keeps winsplit's explicit Apache option and original Deley credit in the reviewed binary distribution", () => {
    const root = "winsplit-0.1.0";
    const checksum = "3ab703352da6a72f35c39a533526393725640575bb211f61987a2748323ad956";
    expect(selectReviewedCrateLicense(root, checksum, "MIT OR Apache-2.0")).toBe("Apache-2.0");
    const notices = readReviewedCrateNotices(root, checksum, binaryDistribution);
    expect(notices).toHaveLength(1);
    expect(notices[0]!.bytes.toString()).toContain("David Deley");
    expect(notices[0]!.bytes.toString()).toContain("at your option");
    expect(() => readReviewedCrateNotices(root, undefined, binaryDistribution)).toThrow(
      /exact published archive/,
    );
    expect(() => selectReviewedCrateLicense(root, checksum, "MIT AND Apache-2.0")).toThrow(
      /does not offer/,
    );
  });
  it("retains linux-keyutils C attribution and complete LGPL independently of the Rust Apache choice", () => {
    const root = "linux-keyutils-0.2.4";
    const checksum = "761e49ec5fd8a5a463f9b84e877c373d888935b71c6be78f3767fe2ae6bed18e";
    expect(selectReviewedCrateLicense(root, checksum, "Apache-2.0 OR MIT")).toBe("Apache-2.0");
    const notices = readReviewedCrateNotices(root, checksum, binaryDistribution);
    expect(notices).toHaveLength(3);
    expect(notices[1]!.bytes.toString()).toContain("Red Hat");
    expect(notices[1]!.bytes.toString()).toMatch(/version\s*\*\s*2 of the License/);
    expect(notices[2]!.bytes.toString()).toContain("Version 2.1, February 1999");
    expect(notices[2]!.bytes.toString()).toContain("END OF TERMS AND CONDITIONS");
  });
  it("keeps debugserver's generated-code provenance and exact Microsoft license without inventing Rust authors", () => {
    const root = "debugserver-types-0.5.0";
    const checksum = "2bf6834a70ed14e8e4e41882df27190bea150f1f6ecf461f1033f8739cd8af4a";
    expect(selectReviewedCrateLicense(root, checksum, "MIT")).toBeUndefined();
    const notices = readReviewedCrateNotices(root, checksum, binaryDistribution);
    expect(notices).toHaveLength(2);
    expect(notices[0]!.path).toContain("Marwes/debugserver-types");
    expect(notices[1]!.bytes.toString()).toContain("Copyright (c) Microsoft Corporation.");
    expect(notices[1]!.bytes.toString()).toContain("Attribution 3.0 United States");
    expect(notices[1]!.bytes.toString()).toContain("Code is licensed under the MIT License");
    expect(() => readReviewedCrateNotices(root, "0".repeat(64), binaryDistribution)).toThrow(
      /exact published archive/,
    );
  });
  it.each([
    undefined,
    { ...binaryDistribution, sourceCommit: "0".repeat(40) },
    { ...binaryDistribution, sourceSha256: "0".repeat(64) },
    { ...binaryDistribution, payloadArchives: binaryDistribution.payloadArchives.slice(1) },
    {
      ...binaryDistribution,
      payloadArchives: binaryDistribution.payloadArchives.map((archive, index) =>
        index === 0 ? { ...archive, sha256: "0".repeat(64) } : archive,
      ),
    },
    {
      ...binaryDistribution,
      payloadArchives: [
        binaryDistribution.payloadArchives[1]!,
        ...binaryDistribution.payloadArchives.slice(1),
      ],
    },
  ])(
    "reopens binary-only review for missing or changed source/platform evidence (%#)",
    (distribution) => {
      expect(() =>
        readReviewedCrateNotices(
          "winsplit-0.1.0",
          "3ab703352da6a72f35c39a533526393725640575bb211f61987a2748323ad956",
          distribution,
        ),
      ).toThrow(/reviewed binary-only scope/);
    },
  );
  it("selects an actually offered Apache branch only for an audited archive", () => {
    const root = "io_tee-0.1.1";
    const checksum = "4b3f7cef34251886990511df1c61443aa928499d598a9473929ab5a90a527304";
    expect(selectReviewedCrateLicense(root, checksum, "MIT OR Apache-2.0")).toBe("Apache-2.0");
    expect(selectReviewedCrateLicense(root, checksum, "Apache-2.0/MIT")).toBe("Apache-2.0");
    expect(() => selectReviewedCrateLicense(root, checksum, "MIT AND Apache-2.0")).toThrow(
      /does not offer/,
    );
    expect(() =>
      selectReviewedCrateLicense(root, checksum, "Apache-2.0 WITH LLVM-exception"),
    ).toThrow(/does not offer/);
    expect(() => selectReviewedCrateLicense(root, undefined, "MIT OR Apache-2.0")).toThrow(
      /exact published archive/,
    );
    expect(
      selectReviewedCrateLicense("io_tee-0.1.2", checksum, "MIT OR Apache-2.0"),
    ).toBeUndefined();
    expect(readReviewedCrateNotices(root, checksum)[0]!.bytes.toString()).toContain(
      "at your option",
    );
  });
  it("retains the independent WHATWG source-portions license with eventsource's declaration", () => {
    const root = "eventsource-stream-0.2.3";
    const checksum = "74fef4569247a5f429d9156b9d0a2599914385dd189c539334c625d8099d90ab";
    expect(selectReviewedCrateLicense(root, checksum, "MIT OR Apache-2.0")).toBe("Apache-2.0");
    const notices = readReviewedCrateNotices(root, checksum);
    expect(notices).toHaveLength(2);
    expect(notices[0]!.bytes.toString()).toContain("MIT OR Apache-2.0");
    expect(notices[1]!.bytes.toString()).toContain("source code");
    expect(notices[1]!.bytes.toString()).toContain("Redistributions in binary form");
    expect(() => readReviewedCrateNotices(root, "0".repeat(64))).toThrow(/exact published archive/);
  });
  it("keeps the crc32c MIT supplement and the original Zlib translation and redistribution notices together", () => {
    const notices = readReviewedCrateNotices(
      "crc32c-0.6.8",
      "3a47af21622d091a8f0fb295b88bc886ac74efcc613efc19f5d0b21de5c89e47",
    );
    expect(notices).toHaveLength(3);
    expect(notices[0]!.bytes.toString()).toContain("Copyright (c) 2017-2025 Zack Owens");
    expect(notices[1]!.bytes.toString()).toContain("line-by-line translation");
    expect(notices[1]!.bytes.toString()).toContain("1995-2006, 2010, 2011, 2012, 2016 Mark Adler");
    expect(notices[2]!.bytes.toString()).toContain(
      "Altered source versions must be plainly marked",
    );
    expect(notices[2]!.bytes.toString()).toContain("This notice may not be removed or altered");
    expect(() => readReviewedCrateNotices("crc32c-0.6.8")).toThrow(/exact published archive/);
    expect(() => readReviewedCrateNotices("crc32c-0.6.8", "0".repeat(64))).toThrow(
      /exact published archive/,
    );
    expect(
      readReviewedCrateNotices(
        "crc32c-0.6.9",
        "3a47af21622d091a8f0fb295b88bc886ac74efcc613efc19f5d0b21de5c89e47",
      ),
    ).toEqual([]);
  });
  it("retains the source-matched Android support crate's actual 1Password MIT notice", () => {
    const notices = readReviewedCrateNotices(
      "rustls-platform-verifier-android-0.1.1",
      "f87165f0995f63a9fbeea62b64d10b4d9d8e78ec6d7d51fb2125fda7bb36788f",
    );
    expect(notices).toHaveLength(1);
    expect(notices[0]!.bytes.byteLength).toBe(1066);
    expect(notices[0]!.bytes.toString()).toContain("Copyright (c) 2022 1Password");
    expect(notices[0]!.path).toContain("da3d9c36f48fb9f8f97e94f132fdab67ab0fc75b");
    expect(() =>
      readReviewedCrateNotices("rustls-platform-verifier-android-0.1.1", "0".repeat(64)),
    ).toThrow(/exact published archive/);
    expect(
      readReviewedCrateNotices(
        "rustls-platform-verifier-android-0.1.2",
        "f87165f0995f63a9fbeea62b64d10b4d9d8e78ec6d7d51fb2125fda7bb36788f",
      ),
    ).toEqual([]);
  });
  it("preserves the immediate upstream notice-only fix for both unchanged fax releases", () => {
    const fax = readReviewedCrateNotices(
      "fax-0.2.6",
      "f05de7d48f37cd6730705cbca900770cab77a89f413d23e100ad7fad7795a0ab",
    );
    const derive = readReviewedCrateNotices(
      "fax_derive-0.2.0",
      "a0aca10fb742cb43f9e7bb8467c91aa9bcb8e3ffbc6a6f7389bb93ffc920577d",
    );
    expect(fax).toHaveLength(1);
    expect(derive).toEqual(fax);
    expect(fax[0]!.bytes.byteLength).toBe(1075);
    expect(fax[0]!.bytes.toString()).toContain("Copyright © 2021 The pdf-rs contributers.");
    expect(fax[0]!.bytes.toString()).toContain("THE SOFTWARE IS PROVIDED");
    expect(fax[0]!.path).toContain("5d70a161e33b62305f8bce7af3f7fbd011cfaf5d");
  });
  it("does not transfer the fax notice to altered archives or unrelated releases", () => {
    expect(() => readReviewedCrateNotices("fax-0.2.6")).toThrow(/exact published archive/);
    expect(() =>
      readReviewedCrateNotices(
        "fax_derive-0.2.0",
        "f05de7d48f37cd6730705cbca900770cab77a89f413d23e100ad7fad7795a0ab",
      ),
    ).toThrow(/exact published archive/);
    expect(
      readReviewedCrateNotices(
        "fax-0.2.7",
        "f05de7d48f37cd6730705cbca900770cab77a89f413d23e100ad7fad7795a0ab",
      ),
    ).toEqual([]);
  });
  it("preserves the complete ICU and third-party data notice bound to the published crate", () => {
    const notices = readReviewedCrateNotices(
      "deno_core_icudata-0.78.0",
      "b963d2d79672b4c379e4511acccd27bb35b4c1b32a93f596d52ff14a064293bc",
    );
    expect(notices).toHaveLength(1);
    expect(notices[0]!.bytes.byteLength).toBe(27_718);
    expect(notices[0]!.bytes.toString()).toContain("UNICODE LICENSE V3");
    expect(notices[0]!.bytes.toString()).toContain("Third-Party Software Licenses");
  });
  it("does not reuse reviewed evidence for an unverified archive or another version", () => {
    expect(() => readReviewedCrateNotices("deno_core_icudata-0.78.0")).toThrow(
      /exact published archive/,
    );
    expect(() => readReviewedCrateNotices("deno_core_icudata-0.78.0", "0".repeat(64))).toThrow(
      /exact published archive/,
    );
    expect(
      readReviewedCrateNotices(
        "deno_core_icudata-0.79.0",
        "b963d2d79672b4c379e4511acccd27bb35b4c1b32a93f596d52ff14a064293bc",
      ),
    ).toEqual([]);
  });
});

describe("license grants stored in AUTHORS", () => {
  it.each([
    [
      "LICENSE: MIT\nPermission is hereby granted ... THE SOFTWARE IS PROVIDED ...\nCopyright Actual Authors",
      true,
    ],
    ["AUTHORS:\nSomeone\nCopyright Actual Authors", false],
  ])("requires an actual grant, not a contributor list", async (text, accepted) => {
    const file = Path.join(makeTempDir(), "authors.tar.gz");
    FS.writeFileSync(
      file,
      gzipSync(
        Buffer.concat([
          tarEntry("package/Cargo.toml", Buffer.from('[package]\nlicense = "MIT"\n')),
          tarEntry("package/AUTHORS", Buffer.from(text)),
          Buffer.alloc(1024),
        ]),
      ),
    );
    const index = await indexRepoArchive(file, { label: "AUTHORS example" });
    expect(index.licenseFiles.has("AUTHORS")).toBe(accepted);
    if (accepted) expect(index.licenseFiles.get("AUTHORS")?.toString()).toBe(text);
  });
});

describe("published source header notices", () => {
  async function notices(entries: Array<[string, string]>, selected = "MIT") {
    const file = Path.join(makeTempDir(), "source-headers.tar.gz");
    FS.writeFileSync(
      file,
      gzipSync(
        Buffer.concat([
          ...entries.map(([name, source]) => tarEntry(`package/${name}`, Buffer.from(source))),
          Buffer.alloc(1024),
        ]),
      ),
    );
    return readCrateSourceHeaderNotices(file, "", selected);
  }
  it("retains actual copyright and license declarations without copying implementation", async () => {
    const header =
      "/*\n * Copyright (c) Actual Authors.\n * Licensed under MIT or Apache License, Version 2.0.\n */\n";
    const result = await notices([["src/lib.rs", `${header}pub fn implementation() {}`]]);
    expect(result.map((row) => row.path)).toEqual(["src/lib.rs"]);
    expect(result[0]?.bytes.toString()).toBe(header);
  });
  it("does not infer a copyright notice from metadata, code strings or an author name", async () => {
    expect(
      await notices([
        ["Cargo.toml", '[package]\nlicense="MIT"\nauthors=["Someone"]'],
        ["src/lib.rs", 'const NOTICE: &str = "Copyright Authors, MIT license";'],
      ]),
    ).toEqual([]);
  });
  it("refuses mixed source grants instead of hiding an unmatched third-party notice", async () => {
    expect(
      await notices([
        ["src/lib.rs", "// Copyright Project Authors. MIT license.\npub fn f() {}"],
        ["src/vendor.c", "/* Copyright Another Author. See zlib.h for conditions. */\nint value;"],
      ]),
    ).toEqual([]);
  });
  it("refuses a license family not named by the actual source header", async () => {
    expect(
      await notices(
        [["src/lib.rs", "// Copyright Authors. MIT license.\npub fn f() {}"]],
        "Apache-2.0",
      ),
    ).toEqual([]);
  });
  it("leaves later and prose notices for review instead of silently dropping them", async () => {
    const main = ["src/lib.rs", "// Copyright Project Authors. MIT license.\npub fn f() {}"] as [
      string,
      string,
    ];
    expect(
      await notices([
        main,
        ["README.md", "# Project\nCopyright Other Authors. See additional terms."],
      ]),
    ).toEqual([]);
    expect(
      await notices([
        ["src/lib.rs", `${main[1]}\n/* Copyright Other Authors. See additional terms. */`],
      ]),
    ).toEqual([]);
  });
});

describe("streaming tar reader", () => {
  it("reads entries across arbitrary chunk boundaries, with pax long paths", () => {
    const longPath = `package/${"deep/".repeat(30)}LICENSE`;
    const pax = Buffer.from(`${(` path=${longPath}\n`.length + 3).toString()} path=${longPath}\n`);
    const archive = Buffer.concat([
      tarEntry("package/README.md", Buffer.from("hello")),
      tarEntry("package/empty", Buffer.alloc(0)),
      tarEntry("PaxHeader", pax, "x"),
      tarEntry("ignored-short-name", Buffer.from("MIT text")),
      tarEntry("package/dir", Buffer.alloc(0), "5"),
      Buffer.alloc(1024),
    ]);
    for (const chunkSize of [1, 7, 512, 100_000]) {
      const seen: Array<{ header: TarEntryHeader; body: string }> = [];
      const parser = createTarParser({
        entry: (header) => {
          const parts: Buffer[] = [];
          return {
            chunk: (bytes) => parts.push(Buffer.from(bytes)),
            end: () => seen.push({ header, body: Buffer.concat(parts).toString("utf8") }),
          };
        },
      });
      for (let offset = 0; offset < archive.length; offset += chunkSize) {
        parser.write(archive.subarray(offset, offset + chunkSize));
      }
      parser.finish();
      expect(seen.map((entry) => [entry.header.path, entry.body])).toEqual([
        ["package/README.md", "hello"],
        ["package/empty", ""],
        [longPath, "MIT text"],
      ]);
    }
  });

  it("rejects a corrupted header", () => {
    const archive = tarEntry("package/a", Buffer.from("x"));
    archive[0] = 0x41;
    const parser = createTarParser({ entry: () => null });
    expect(() => parser.write(archive)).toThrow(/checksum/);
  });
});

describe("bun.lock entries", () => {
  const codexLauncher: NpmVersionDocument = {
    name: "@openai/codex",
    version: "0.163.0",
    bin: { codex: "bin/codex.js" },
    optionalDependencies: {
      "@openai/codex-linux-x64": "npm:@openai/codex@0.163.0-linux-x64",
      "@openai/codex-linux-arm64": "npm:@openai/codex@0.163.0-linux-arm64",
      "@openai/codex-darwin-x64": "npm:@openai/codex@0.163.0-darwin-x64",
      "@openai/codex-darwin-arm64": "npm:@openai/codex@0.163.0-darwin-arm64",
      "@openai/codex-win32-x64": "npm:@openai/codex@0.163.0-win32-x64",
      "@openai/codex-win32-arm64": "npm:@openai/codex@0.163.0-win32-arm64",
    },
    dist: {
      integrity:
        "sha512-HNd7vR9oTK6M2ikxFnvNDCdYUgAsyo9VVnd5KnEd2ON0GYI++7MiX9XNPUkhtdgGKFPsWS+CEppQ1UU63uVhUw==",
      tarball: "https://registry.npmjs.org/@openai/codex/-/codex-0.163.0.tgz",
    },
  };

  it("reproduces bun's entries for launcher and platform packages", () => {
    expect(bunLockPackageEntry("@openai/codex", codexLauncher)).toBe(
      `"@openai/codex": ["@openai/codex@0.163.0", "", { "optionalDependencies": { "@openai/codex-darwin-arm64": "npm:@openai/codex@0.163.0-darwin-arm64", "@openai/codex-darwin-x64": "npm:@openai/codex@0.163.0-darwin-x64", "@openai/codex-linux-arm64": "npm:@openai/codex@0.163.0-linux-arm64", "@openai/codex-linux-x64": "npm:@openai/codex@0.163.0-linux-x64", "@openai/codex-win32-arm64": "npm:@openai/codex@0.163.0-win32-arm64", "@openai/codex-win32-x64": "npm:@openai/codex@0.163.0-win32-x64" }, "bin": { "codex": "bin/codex.js" } }, "sha512-HNd7vR9oTK6M2ikxFnvNDCdYUgAsyo9VVnd5KnEd2ON0GYI++7MiX9XNPUkhtdgGKFPsWS+CEppQ1UU63uVhUw=="],`,
    );
    expect(
      bunLockPackageEntry("@anthropic-ai/claude-agent-sdk-linux-x64-musl", {
        name: "@anthropic-ai/claude-agent-sdk-linux-x64-musl",
        version: "0.3.318",
        os: ["linux"],
        cpu: ["x64"],
        libc: ["musl"],
        dist: { integrity: "sha512-AAAA", tarball: "" },
      }),
    ).toBe(
      `"@anthropic-ai/claude-agent-sdk-linux-x64-musl": ["@anthropic-ai/claude-agent-sdk-linux-x64-musl@0.3.318", "", { "os": "linux", "cpu": "x64", "libc": "musl" }, "sha512-AAAA"],`,
    );
  });

  it("matches the committed root bun.lock line for the bundled Codex launcher", () => {
    const lock = FS.readFileSync(Path.join(REPO_ROOT, "bun.lock"), "utf8");
    const current = findBunLockPackageEntry(lock, "@openai/codex");
    expect(current).toMatch(/^"@openai\/codex": \["@openai\/codex@\d/);
  });

  it("replaces package entries and workspace specs only", () => {
    const lock = `{
  "workspaces": {
    "apps/server": {
      "dependencies": {
        "@anthropic-ai/claude-agent-sdk": "0.3.285",
        "other": "0.3.285",
      },
    },
  },
  "packages": {
    "@anthropic-ai/claude-agent-sdk": ["@anthropic-ai/claude-agent-sdk@0.3.285", "", {}, "sha512-old"],

    "other": ["other@0.3.285", "", {}, "sha512-x"],
  }
}
`;
    const specs = replaceBunLockWorkspaceSpec(
      lock,
      "@anthropic-ai/claude-agent-sdk",
      "0.3.285",
      "0.3.318",
    );
    expect(specs.count).toBe(1);
    const next = replaceBunLockPackageEntry(
      specs.text,
      "@anthropic-ai/claude-agent-sdk",
      `"@anthropic-ai/claude-agent-sdk": ["@anthropic-ai/claude-agent-sdk@0.3.318", "", {}, "sha512-new"],`,
    );
    expect(next).toContain(`"@anthropic-ai/claude-agent-sdk": "0.3.318",`);
    expect(next).toContain(`"other": "0.3.285",`);
    expect(next).toContain(`["@anthropic-ai/claude-agent-sdk@0.3.318", "", {}, "sha512-new"]`);
    expect(next).toContain(`["other@0.3.285", "", {}, "sha512-x"]`);
  });
});

describe("repository rewrites", () => {
  it("replaces whole versions in plain and regex spellings only", () => {
    const root = makeTempDir();
    FS.writeFileSync(
      Path.join(root, "a.ts"),
      `"0.163.0" v0.163.0 npm:@openai/codex@0.163.0-win32-x64 /expected 0\\.163\\.0/ 10.163.0 0.163.01 0.163.0.1\n`,
    );
    replaceVersionLiterals(root, ["a.ts"], "0.163.0", "0.166.0");
    expect(FS.readFileSync(Path.join(root, "a.ts"), "utf8")).toBe(
      `"0.166.0" v0.166.0 npm:@openai/codex@0.166.0-win32-x64 /expected 0\\.166\\.0/ 10.163.0 0.163.01 0.166.0.1\n`,
    );
  });

  it("replaces one runtime's native manifest entries in sorted order and keeps the rest", () => {
    const root = makeTempDir();
    FS.mkdirSync(Path.join(root, "scripts"));
    const manifestPath = Path.join(root, "scripts", "windows-native-payload-manifest.json");
    FS.writeFileSync(
      manifestPath,
      JSON.stringify({
        schemaVersion: 2,
        windows: {
          x64: {
            signingTargets: [],
            preservedPayloads: [
              { path: "resources/a.node", sha256: "1", source: "a@1" },
              {
                path: "resources/codex-runtime/t/bin/codex.exe",
                sha256: "2",
                source: "@openai/codex@1-win32-x64",
              },
              { path: "resources/z.node", sha256: "3", source: "z@1" },
            ],
          },
        },
      }),
    );
    updateWindowsNativeManifest(root, {
      pathPrefix: "resources/codex-runtime/",
      sourcePrefix: "@openai/codex@",
      entries: [
        {
          path: "resources/codex-runtime/t/z.dll",
          sha256: "5",
          source: "@openai/codex@2-win32-x64",
        },
        {
          path: "resources/codex-runtime/t/bin/codex.exe",
          sha256: "4",
          source: "@openai/codex@2-win32-x64",
        },
      ],
    });
    const manifest = JSON.parse(FS.readFileSync(manifestPath, "utf8"));
    expect(
      manifest.windows.x64.preservedPayloads.map((entry: { sha256: string }) => entry.sha256),
    ).toEqual(["1", "4", "5", "3"]);
  });

  it("adds a changelog line once", () => {
    const root = makeTempDir();
    FS.writeFileSync(
      Path.join(root, "CHANGELOG.md"),
      "# Changelog\n\n## Unreleased\n\n### Added\n\n- a\n\n### Changed\n\n- b\n\n## 1.0.0\n\n### Changed\n\n- c\n",
    );
    addChangelogLine(root, "Bumped.");
    addChangelogLine(root, "Bumped.");
    expect(FS.readFileSync(Path.join(root, "CHANGELOG.md"), "utf8")).toBe(
      "# Changelog\n\n## Unreleased\n\n### Added\n\n- a\n\n### Changed\n\n- Bumped.\n- b\n\n## 1.0.0\n\n### Changed\n\n- c\n",
    );
  });
});
