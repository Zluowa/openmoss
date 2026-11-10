// FILE: reviewed-notices.ts
// Purpose: Preserve explicitly verified notices omitted from published crates.
// Layer: Release/build evidence; every entry is tied to the published archive digest.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { parseSpdxExpression } from "./spdx.ts";

interface ReviewedNotice {
  readonly path: string;
  readonly bytes: Buffer;
}

// denoland/deno_core_icudata#8 identifies rusty_v8 v152.0.0. Its pinned ICU
// submodule is d578f2e8b7bd5938e21cfb6bf15c079e0aa5b738. The published crate's
// 10,876,560-byte src/icudtl.dat matches that source's common/icudtl.dat exactly:
// SHA-256 9f48c7f9c7c94d516a14870707e910ab94d75ae640ff6842c4af53276cd26ebe.
// Keep the complete ICU notice (including third-party dictionary/data notices),
// rather than treating the outer crate's MIT label as the embedded data license.
const ICU_CRATE = "deno_core_icudata-0.78.0";
const ICU_CRATE_SHA256 = "b963d2d79672b4c379e4511acccd27bb35b4c1b32a93f596d52ff14a064293bc";
const ICU_NOTICE_SHA256 = "e55522d81edc687a341a4411e0776e54ca654e90147f354a90458aaced4116af";
const ICU_NOTICE_SOURCE =
  "https://chromium.googlesource.com/chromium/deps/icu/+/d578f2e8b7bd5938e21cfb6bf15c079e0aa5b738/LICENSE";

// The two releases identify 40b226eb97b391355e971fd95a8dd532a4c127a0.
// Its immediate child 5d70a161e33b62305f8bce7af3f7fbd011cfaf5d changes only
// LICENSE and derive/LICENSE (a ../LICENSE symlink). The author's commit
// explicitly adds the missing notice for the published crates; no code or
// manifest changed. Preserve those original bytes, including "contributers".
const FAX_CRATES: Readonly<Record<string, string>> = {
  "fax-0.2.6": "f05de7d48f37cd6730705cbca900770cab77a89f413d23e100ad7fad7795a0ab",
  "fax_derive-0.2.0": "a0aca10fb742cb43f9e7bb8467c91aa9bcb8e3ffbc6a6f7389bb93ffc920577d",
};
const FAX_NOTICE_SHA256 = "7101390b4c8edd752f4c0de47f35d61b44d9cf0ee8dd032115e25644e277cfff";
const FAX_NOTICE_SOURCE =
  "https://github.com/pdf-rs/fax/blob/5d70a161e33b62305f8bce7af3f7fbd011cfaf5d/LICENSE";

// These exact releases explicitly offer Apache-2.0 in both their manifest and
// README. Preserve that declaration rather than inventing a missing MIT
// copyright line. Independently derived material is retained below as well.
const REVIEWED_APACHE_CRATES: Readonly<Record<string, string>> = {
  "io_tee-0.1.1": "4b3f7cef34251886990511df1c61443aa928499d598a9473929ab5a90a527304",
  "eventsource-stream-0.2.3": "74fef4569247a5f429d9156b9d0a2599914385dd189c539334c625d8099d90ab",
  "winsplit-0.1.0": "3ab703352da6a72f35c39a533526393725640575bb211f61987a2748323ad956",
  "linux-keyutils-0.2.4": "761e49ec5fd8a5a463f9b84e877c373d888935b71c6be78f3767fe2ae6bed18e",
};

export interface ReviewedBinaryDistribution {
  readonly sourceCommit: string;
  readonly sourceSha256: string;
  readonly payloadArchives: readonly { readonly id: string; readonly sha256: string }[];
}

// These three decisions cover the audited binary/notice distribution only.
// Registry crate sources, rustdoc and copied manuals are not shipped by this
// generator. Reopen the review if that packaging boundary changes. Pin both
// the Codex source archive and every native archive so upgrades fail closed.
function requireReviewedBinaryDistribution(
  root: string,
  actual?: ReviewedBinaryDistribution,
): void {
  const expected: ReviewedBinaryDistribution = JSON.parse(
    readFileSync(
      new URL("./reviewed-notices/codex-0.166.0-binary-distribution.json", import.meta.url),
      "utf8",
    ),
  );
  const archives = actual?.payloadArchives;
  if (
    !actual ||
    actual.sourceCommit !== expected.sourceCommit ||
    actual.sourceSha256 !== expected.sourceSha256 ||
    !archives ||
    archives.length !== expected.payloadArchives.length ||
    new Set(archives.map((archive) => archive.id)).size !== archives.length ||
    expected.payloadArchives.some(
      (archive) =>
        !archives.some(
          (candidate) => candidate.id === archive.id && candidate.sha256 === archive.sha256,
        ),
    )
  ) {
    throw new Error(
      `${root}: source/payload distribution differs from the reviewed binary-only scope; review required.`,
    );
  }
}

export function selectReviewedCrateLicense(
  root: string,
  checksum: string | undefined,
  declared: string,
): string | undefined {
  const expected = REVIEWED_APACHE_CRATES[root];
  if (!expected) return undefined;
  if (checksum !== expected)
    throw new Error(
      `${root}: reviewed license choice requires the exact published archive digest.`,
    );
  const offersApache = (node: ReturnType<typeof parseSpdxExpression>): boolean =>
    node.kind === "id"
      ? node.id === "Apache-2.0" && !node.exception
      : node.kind === "or" && node.items.some(offersApache);
  if (!offersApache(parseSpdxExpression(declared)))
    throw new Error(`${root}: declaration does not offer the reviewed Apache-2.0 choice.`);
  return "Apache-2.0";
}

function checkedNotice(
  root: string,
  file: string,
  digest: string,
  source: string,
): readonly ReviewedNotice[] {
  const bytes = readFileSync(new URL(`./reviewed-notices/${file}`, import.meta.url));
  if (createHash("sha256").update(bytes).digest("hex") !== digest) {
    throw new Error(`${root}: reviewed notice bytes changed.`);
  }
  return [{ path: source, bytes }];
}

export function readReviewedCrateNotices(
  root: string,
  checkedArchiveChecksum?: string,
  distribution?: ReviewedBinaryDistribution,
): readonly ReviewedNotice[] {
  if (
    root === "winsplit-0.1.0" ||
    root === "linux-keyutils-0.2.4" ||
    root === "debugserver-types-0.5.0"
  ) {
    const expectedChecksum =
      root === "debugserver-types-0.5.0"
        ? "2bf6834a70ed14e8e4e41882df27190bea150f1f6ecf461f1033f8739cd8af4a"
        : REVIEWED_APACHE_CRATES[root];
    if (checkedArchiveChecksum !== expectedChecksum)
      throw new Error(
        `${root}: reviewed source notices require the exact published archive digest.`,
      );
    requireReviewedBinaryDistribution(root, distribution);
    if (root === "winsplit-0.1.0")
      return checkedNotice(
        root,
        "winsplit-0.1.0-README.md.txt",
        "39bb1a6d7befd101a9f8228db3b2deab823042b54dc82a410534cb68ba93edbc",
        "https://github.com/chipsenkbeil/winsplit-rs/blob/691e800ac384bc7fc815ca55d1dd2b09b1f15d96/README.md",
      );
    if (root === "linux-keyutils-0.2.4")
      return [
        ...checkedNotice(
          root,
          "linux-keyutils-0.2.4-README.md.txt",
          "60eaaa21859394c2a1679d47763c4d2c31b3fdab7de327ac72f4b4244cac5695",
          "https://github.com/landhb/linux-keyutils/blob/2e81f726ffd3c0165e11fcdbde279b5d8638f47d/README.md",
        ),
        // Keep the original C ABI attribution and full LGPL separately from the
        // Rust package's Apache choice. This does not relicense the C library.
        ...checkedNotice(
          root,
          "linux-keyutils-origin-keyutils.h-header.txt",
          "e0efefef4b48362f5652cc28e2981e017759a53658c121dbe1c9539fa9980621",
          "https://git.kernel.org/pub/scm/linux/kernel/git/dhowells/keyutils.git/tree/keyutils.h?id=cb3bb194cca88211cbfcdde2f10c0f43c3fb8ec3",
        ),
        ...checkedNotice(
          root,
          "linux-keyutils-origin-LICENCE.LGPL.txt",
          "0d15593e3a8ad90917f8509b5ac1e4b5e5d196434a68029aa9dc0858a4a4c521",
          "https://git.kernel.org/pub/scm/linux/kernel/git/dhowells/keyutils.git/tree/LICENCE.LGPL?id=cb3bb194cca88211cbfcdde2f10c0f43c3fb8ec3",
        ),
      ];
    return [
      ...checkedNotice(
        root,
        "debugserver-types-0.5.0-README.md.txt",
        "4604a717a7e8728c09d6b556327f17932f41464682eb4fb66f132edb980a5b9c",
        "https://github.com/Marwes/debugserver-types/blob/d444f163123af5b4fbce7375d1afead7e9b8a224/README.md",
      ),
      // schemafy generates protocol types from DAP v1.34.0. Preserve the exact
      // source's Microsoft notice, including its distinct documentation scope.
      ...checkedNotice(
        root,
        "debugserver-Microsoft-v1.34.0-License.txt",
        "8f1242d5b277faab16d63f91b381b185ab3a12435341ad80c0478cb4226cdb91",
        "https://github.com/microsoft/debug-adapter-protocol/blob/a62c4164506dad981bbccd4d278c584255f1b5b8/License.txt",
      ),
    ];
  }
  if (root === "io_tee-0.1.1" || root === "eventsource-stream-0.2.3") {
    if (checkedArchiveChecksum !== REVIEWED_APACHE_CRATES[root]) {
      throw new Error(
        `${root}: reviewed source notices require the exact published archive digest.`,
      );
    }
    if (root === "io_tee-0.1.1")
      return checkedNotice(
        root,
        "io-tee-0.1.1-README.md",
        "0ba20a4b5d8188a85014c5f6d52b5407aec2077986c05f6ba686f9899b767b95",
        "https://github.com/TheOnlyMrCat/io_tee/blob/8a7adecebf3429cbc58a0368751d1851dfaf58ed/README.md",
      );
    return [
      ...checkedNotice(
        root,
        "eventsource-stream-0.2.3-README.md",
        "f17f6cc26f19643dbadaaad9901d245d4645ef8fbac8266b33105392dd1f8601",
        "https://github.com/jpopesculian/eventsource-stream/blob/3d46f1c758f9ee4681e9da0427556d24c53f9c01/README.md",
      ),
      // The specification explicitly licenses portions embedded in source code
      // under BSD-3-Clause. Retain the complete scope statement and original text.
      ...checkedNotice(
        root,
        "eventsource-stream-0.2.3-WHATWG-LICENSE.txt",
        "85dc6f5ccb57a6fe8c33d158f9fc8fc7ee5655a5d3db2cdd131c6a3d0f48a864",
        "https://github.com/whatwg/html/blob/2a1c38ff159196f3039b6578c56355bd6ed11400/LICENSE",
      ),
    ];
  }
  // The maintainer accepted the MIT supplement in PR #77. The history diverges
  // from the crate's VCS commit, but all nine src files and build.rs match
  // byte-for-byte. Keep the original Rust translation notice and complete Zlib
  // terms too: the project MIT notice does not replace that derived-code grant.
  // Zlib v1.2.11 has the exact quoted header; the original mutable master link
  // does not establish the unique revision originally translated.
  if (root === "crc32c-0.6.8") {
    if (
      checkedArchiveChecksum !== "3a47af21622d091a8f0fb295b88bc886ac74efcc613efc19f5d0b21de5c89e47"
    ) {
      throw new Error(
        `${root}: reviewed source notices require the exact published archive digest.`,
      );
    }
    return [
      ...checkedNotice(
        root,
        "crc32c-0.6.8-LICENSE-MIT.txt",
        "10ee639af58890becf8c0751984e576cf6ef7d3f619cbfc47603d7be5eb77e01",
        "https://github.com/zowens/crc32c/blob/66c7c4905a6cf624cb1e1cbc21e7dd3cbce6faa1/LICENSE-MIT",
      ),
      ...checkedNotice(
        root,
        "crc32c-0.6.8-combine-header.txt",
        "c3bcdf06815ecd0518c701f59a8e8c5dc1a48fc87458a6bc4f3c90b1df3f42a6",
        "https://github.com/zowens/crc32c/blob/254a861f7cc71bfe455e86f0e1d86e3c83c33390/src/combine.rs",
      ),
      ...checkedNotice(
        root,
        "crc32c-0.6.8-zlib-distribution-notice.txt",
        "5b305a8fcbfac28f3238dfe6db82016dbc72b986be3034e843648f89ffc2bfb5",
        "https://github.com/madler/zlib/blob/cacf7f1d4e3d44d871b605da3b647f07d718623f/zlib.h",
      ),
    ];
  }
  // This release omits VCS metadata and LICENSE symlinks. Its original
  // manifest and every published Rust source are byte-identical to the 0.1.1
  // version commit below; both POMs equal its template with VERSION=0.1.1.
  // The AAR contains only this library's four classes and Kotlin module
  // metadata (no embedded Kotlin/Android dependency). This is attribution
  // evidence, not a claim to have reproduced JVM bytecode.
  if (root === "rustls-platform-verifier-android-0.1.1") {
    if (
      checkedArchiveChecksum !== "f87165f0995f63a9fbeea62b64d10b4d9d8e78ec6d7d51fb2125fda7bb36788f"
    ) {
      throw new Error(
        `${root}: reviewed source notices require the exact published archive digest.`,
      );
    }
    return checkedNotice(
      root,
      "rustls-platform-verifier-android-0.1.1-LICENSE-MIT.txt",
      "1c7cf76689c837a68ed8d704994e52a0f2940c087958f860d17f3186afbdcc0c",
      "https://github.com/rustls/rustls-platform-verifier/blob/da3d9c36f48fb9f8f97e94f132fdab67ab0fc75b/LICENSE-MIT",
    );
  }
  const faxChecksum = FAX_CRATES[root];
  if (faxChecksum) {
    if (checkedArchiveChecksum !== faxChecksum) {
      throw new Error(
        `${root}: reviewed source notices require the exact published archive digest.`,
      );
    }
    return checkedNotice(root, "fax-0.2.6-LICENSE.txt", FAX_NOTICE_SHA256, FAX_NOTICE_SOURCE);
  }
  if (root !== ICU_CRATE) return [];
  if (checkedArchiveChecksum !== ICU_CRATE_SHA256) {
    throw new Error(
      `${root}: reviewed embedded-data notices require the exact published archive digest.`,
    );
  }
  return checkedNotice(
    root,
    "deno-core-icudata-0.78.0-icu-LICENSE.txt",
    ICU_NOTICE_SHA256,
    ICU_NOTICE_SOURCE,
  );
}
