import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

import {
  findBrandIdentityViolations,
  findLegacyIdentityViolations,
  findPublicRuntimeBrandViolations,
  findUnreviewedBrandImages,
  findVisualBrandAssetViolations,
  type BrandIdentityRequirement,
} from "./check-brand-identity";

const requirements: readonly BrandIdentityRequirement[] = [
  {
    path: "identity.ts",
    requiredText: ['brand = "Moss"', 'origin = "moss://app"'],
    forbiddenText: ['brand = "Synara"'],
  },
];
const characters = (...codes: number[]): string => String.fromCharCode(...codes);
const shortName = characters(116, 51);
const firstName = `${shortName}${characters(99, 111, 100, 101)}`;
const firstDisplayName = characters(84, 51, 67, 111, 100, 101);
const firstSpacedDisplayName = `${characters(84, 51)} Code`;
const companyDisplayName = `${characters(84, 51)} ${characters(84, 111, 111, 108, 115)}`;
const legalNotice = `Copyright (c) 2026 ${companyDisplayName} Inc.`;
const originsAttribution = `[${firstDisplayName}](https://github.com/pingdotgg/${firstName}), but Moss is now a separate product with its own`;
const releaseAttribution = `**A review of the Moss codebase found an analytics configuration inherited from the original ${firstSpacedDisplayName} codebase when Moss was created as a clone in March. We did not add it, and we had no access to the PostHog project receiving the events.**`;
const inAppReleaseAttribution = `"A review of the Moss codebase found an analytics configuration inherited from the original ${firstSpacedDisplayName} codebase when Moss was created as a clone in March.",`;

describe("Moss brand identity guard", () => {
  it("limits historical visual identifiers to exact reader declarations with current writers", () => {
    for (const [path, legacy, current] of [
      [
        "packages/contracts/src/inlineVisual.ts",
        'export const INLINE_VISUAL_EMBED_FENCE_UPSTREAM_ALIAS = "synara-visual";',
        'export const INLINE_VISUAL_EMBED_FENCE = "moss-visual";',
      ],
      [
        "packages/shared/src/inlineVisual.ts",
        'const LEGACY_SCROLL_INTENT_METHOD = "synara/notifications/scroll-intent";',
        'const SCROLL_INTENT_METHOD = "moss/notifications/scroll-intent";',
      ],
      [
        "packages/shared/src/inlineVisual.ts",
        'const LEGACY_STOPPED_METHOD = "synara/notifications/visual-stopped";',
        'const STOPPED_METHOD = "moss/notifications/visual-stopped";',
      ],
    ] as const) {
      const contents = readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
      expect(findPublicRuntimeBrandViolations([{ path, contents }])).toEqual([]);
      expect(
        findPublicRuntimeBrandViolations([{ path: "other.ts", contents }]).length,
      ).toBeGreaterThan(0);
      expect(
        findPublicRuntimeBrandViolations([{ path, contents: contents.replace(current, "") }])
          .length,
      ).toBeGreaterThan(0);
      expect(
        findPublicRuntimeBrandViolations([{ path, contents: `${contents}\n${legacy}` }]).length,
      ).toBeGreaterThan(0);
    }
  });

  it.each(["LEGACY_SCROLL_INTENT_METHOD", "LEGACY_STOPPED_METHOD"])(
    "rejects new frame writes using %s",
    (legacy) => {
      const path = "packages/shared/src/inlineVisual.ts";
      const contents = readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
      for (const write of [
        `post({ jsonrpc: "2.0", method: ${legacy} });`,
        `const emitted = JSON.stringify(${legacy});`,
        `parent.postMessage({ ["method"]: ${legacy} }, "*");`,
      ]) {
        expect(
          findPublicRuntimeBrandViolations([{ path, contents: `${contents}\n${write}` }]).length,
        ).toBeGreaterThan(0);
      }
    },
  );

  it("rejects using the historical fence alias in the real gateway writer", () => {
    const path = "apps/server/src/agentGateway/inlineVisualTools.ts";
    const contents = readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
    expect(findPublicRuntimeBrandViolations([{ path, contents }])).toEqual([]);
    expect(
      findPublicRuntimeBrandViolations([
        {
          path,
          contents: contents.replaceAll(
            "INLINE_VISUAL_EMBED_FENCE",
            "INLINE_VISUAL_EMBED_FENCE_UPSTREAM_ALIAS",
          ),
        },
      ]).length,
    ).toBeGreaterThan(0);
  });

  it("matches reviewed Windows paths without broadening legacy exceptions", () => {
    const path = "apps\\server\\src\\orchestration\\Layers\\ProviderCommandReactor.ts";
    const legacy = "const legacyTimeout = env.SYNARA_PRE_TURN_BASELINE_TIMEOUT_MS;";
    const contents = `${legacy}\nconst current = env.MOSS_PRE_TURN_BASELINE_TIMEOUT_MS ?? legacyTimeout;`;
    expect(findPublicRuntimeBrandViolations([{ path, contents }])).toEqual([]);
    expect(findPublicRuntimeBrandViolations([{ path: "other.ts", contents }])).toHaveLength(1);
    expect(
      findPublicRuntimeBrandViolations([{ path, contents: `${contents}\n${legacy}` }]),
    ).toHaveLength(1);
  });

  it("allows a reviewed legacy read exactly once only beside the current operator name", () => {
    const path = "apps/server/src/orchestration/Layers/ProviderCommandReactor.ts";
    const legacy = "const legacyTimeout = env.SYNARA_PRE_TURN_BASELINE_TIMEOUT_MS;";
    const contents = `${legacy}\nconst current = env.MOSS_PRE_TURN_BASELINE_TIMEOUT_MS ?? legacyTimeout;`;
    expect(findPublicRuntimeBrandViolations([{ path, contents }])).toEqual([]);
    expect(findPublicRuntimeBrandViolations([{ path: "other.ts", contents }])).toHaveLength(1);
    expect(findPublicRuntimeBrandViolations([{ path, contents: legacy }])).toHaveLength(1);
    expect(
      findPublicRuntimeBrandViolations([{ path, contents: `${contents}\n${legacy}` }]),
    ).toHaveLength(1);
    expect(
      findPublicRuntimeBrandViolations([
        { path, contents: `${contents}\nconst label = "Synara";` },
      ]),
    ).toHaveLength(1);
  });

  it("rejects new writes that reuse an approved legacy storage constant", () => {
    for (const [path, forbiddenWrite] of [
      [
        "apps/server/src/provider/openCodeV2Client.ts",
        "native.session.instructions.entry.put({sessionID, key: LEGACY_INSTRUCTION_KEY, value: prompt.system});",
      ],
      [
        "apps/desktop/src/backendIssueDetector.ts",
        "process.stdout.write(LEGACY_DIAGNOSTIC_ISSUE_PREFIX + payload);",
      ],
    ]) {
      const contents = readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
      expect(findPublicRuntimeBrandViolations([{ path: path!, contents }])).toEqual([]);
      expect(
        findPublicRuntimeBrandViolations([
          { path: path!, contents: `${contents}\n${forbiddenWrite}` },
        ]).length,
      ).toBeGreaterThan(0);
    }
  });

  it("does not retain brand exceptions for a removed sponsorship surface", () => {
    const path = "apps/web/src/components/SponsorLandingBanner.tsx";
    const contents = [
      'const LEGACY_DISMISSED_STORAGE_KEY = "synara:sponsor-landing-banner:dismissed:v1";',
      'const DISMISSED_STORAGE_KEY = "moss:sponsor-landing-banner:dismissed:v1";',
      "getLocalStorageItem(LEGACY_DISMISSED_STORAGE_KEY, Schema.Boolean)",
      'onClick={() => openExternalLink("https://www.trysynara.com/sponsor")}',
      "Support upstream Synara",
      "Visit the upstream project's sponsorship page",
    ].join("\n");
    expect(findPublicRuntimeBrandViolations([{ path, contents }])).toHaveLength(3);
  });
  it("accepts the required Moss public identity", () => {
    expect(
      findBrandIdentityViolations(
        [{ path: "identity.ts", contents: 'brand = "Moss"\norigin = "moss://app"' }],
        requirements,
      ),
    ).toEqual([]);
  });

  it("reports missing files, required text, and retired public text", () => {
    expect(findBrandIdentityViolations([], requirements)).toHaveLength(1);

    const violations = findBrandIdentityViolations(
      [{ path: "identity.ts", contents: 'brand = "Synara"' }],
      requirements,
    );
    expect(violations).toHaveLength(3);
    expect(violations.at(-1)).toMatchObject({ path: "identity.ts", line: 1 });
  });

  it("allows the exact legal attribution once in LICENSE", () => {
    expect(findLegacyIdentityViolations([{ path: "LICENSE", contents: legalNotice }])).toEqual([]);
    expect(
      findLegacyIdentityViolations([{ path: "docs/license-copy.md", contents: legalNotice }]),
    ).toHaveLength(1);
    expect(
      findLegacyIdentityViolations([
        { path: "LICENSE", contents: `${legalNotice}\n${legalNotice}` },
      ]),
    ).toHaveLength(1);
  });

  it("allows the exact predecessor attribution only in the README Origins section", () => {
    expect(
      findLegacyIdentityViolations([
        { path: "README.md", contents: `## Origins\n\n${originsAttribution}` },
      ]),
    ).toEqual([]);
    expect(
      findLegacyIdentityViolations([
        { path: "README.md", contents: `## About\n\n${originsAttribution}` },
      ]),
    ).toHaveLength(1);
    expect(
      findLegacyIdentityViolations([
        {
          path: "README.md",
          contents: `## Origins\n\n${originsAttribution}\nLegacy ${firstName}`,
        },
      ]),
    ).toHaveLength(1);
  });

  it("allows the exact 0.7.0 release attribution only in its approved locations", () => {
    expect(
      findLegacyIdentityViolations([
        { path: "CHANGELOG.md", contents: `## 0.7.0 - 2026-08-05\n\n${releaseAttribution}` },
        {
          path: "apps/web/src/whatsNew/entries.ts",
          contents: inAppReleaseAttribution,
        },
      ]),
    ).toEqual([]);
    expect(
      findLegacyIdentityViolations([
        { path: "CHANGELOG.md", contents: `## 0.6.7 - 2026-08-05\n\n${releaseAttribution}` },
        { path: "apps/web/src/other.ts", contents: inAppReleaseAttribution },
      ]),
    ).toHaveLength(2);
  });

  it("requires reviewed Moss assets to match their approved digests", () => {
    const approvedContents = new TextEncoder().encode("approved Moss icon");
    const approvedDigest = "87786040d4144d0be85d140d5670b37897157510adc785e891899983556218fc";
    const approvedDigests = new Map([["icon.png", approvedDigest]]);

    expect(
      findVisualBrandAssetViolations(
        [{ path: "icon.png", contents: approvedContents }],
        approvedDigests,
      ),
    ).toEqual([]);
    expect(
      findVisualBrandAssetViolations(
        [{ path: "icon.png", contents: new TextEncoder().encode("changed") }],
        approvedDigests,
      ),
    ).toHaveLength(1);
    expect(findVisualBrandAssetViolations([], approvedDigests)).toHaveLength(1);
  });

  it("rejects the upstream author's name in shipped source", () => {
    expect(
      findPublicRuntimeBrandViolations([
        {
          path: "apps/desktop/scripts/provision.mjs",
          contents: 'const id = "com.emanueledipietro.moss";',
        },
      ]),
    ).toHaveLength(1);
  });

  it("requires someone to have reviewed every brand image", () => {
    const approved = new Map([["apps/web/public/app-icons/default.png", "digest"]]);
    expect(findUnreviewedBrandImages(["apps/web/public/app-icons/default.png"], approved)).toEqual(
      [],
    );
    expect(findUnreviewedBrandImages(["apps/web/public/app-icons/beta.png"], approved)).toEqual([
      {
        path: "apps/web/public/app-icons/beta.png",
        line: null,
        text: "Brand image has no reviewed digest; look at it, then add its digest.",
      },
    ]);
  });

  it("allows the real Moss repository coordinate without allowing product rebranding beside it", () => {
    const path = "apps/marketing/src/lib/seo.ts";
    expect(
      findPublicRuntimeBrandViolations([
        { path, contents: 'const repo = "https://github.com/Zluowa/moss-synara";' },
      ]),
    ).toEqual([]);
    expect(
      findPublicRuntimeBrandViolations([
        {
          path,
          contents: 'const name = "Synara"; const repo = "https://github.com/Zluowa/moss-synara";',
        },
      ]),
    ).toHaveLength(1);
  });

  it("rejects the retired mark's drawing and name wherever a Moss name hides them", () => {
    const drawing = '<path d="M2.65188 2.1899C-0.63 5.47"/>';
    expect(
      findPublicRuntimeBrandViolations([
        { path: "apps/web/src/assets/mossLogo.ts", contents: drawing },
      ]),
    ).toHaveLength(1);
    expect(
      findPublicRuntimeBrandViolations([
        { path: "apps/web/src/guest/favicon.svg", contents: drawing },
      ]),
    ).toHaveLength(1);
    expect(
      findPublicRuntimeBrandViolations([
        { path: "apps/web/src/components/SynaraLogo.tsx", contents: "export const MossLogo = 1;" },
      ]),
    ).toHaveLength(1);
  });

  it("rejects naming the upstream project in release notes", () => {
    expect(
      findPublicRuntimeBrandViolations([
        {
          path: "apps/web/src/whatsNew/entries.ts",
          contents:
            'version: "1.0.0",\n"Upstream release history: Synara 1.0.0 is a Stable release.",',
        },
      ]),
    ).toHaveLength(1);
  });

  it("rejects the retired product name anywhere in public runtime source", () => {
    expect(
      findPublicRuntimeBrandViolations([
        { path: "app.ts", contents: 'const label = "Synara";\nconst product = "Moss";' },
      ]),
    ).toEqual([
      {
        path: "app.ts",
        line: 1,
        text: "Retired product identifier is present in native Moss runtime source.",
      },
    ]);
    expect(
      findPublicRuntimeBrandViolations([
        { path: "compat.ts", contents: 'const packageName = "@synara/contracts";' },
      ]),
    ).toEqual([]);
  });
});
