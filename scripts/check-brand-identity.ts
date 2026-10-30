// FILE: check-brand-identity.ts
// Purpose: Locks Moss's native product identity while isolating factual upstream coordinates.

import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { extname, join, relative } from "node:path";

const characters = (...codes: number[]): string => String.fromCharCode(...codes);
const retiredShortName = characters(116, 51);
const retiredFirstName = `${retiredShortName}${characters(99, 111, 100, 101)}`;
const retiredCompanyName = `${retiredShortName}${characters(116, 111, 111, 108, 115)}`;
const retiredSecondName = characters(100, 112, 99, 111, 100, 101);
const retiredPredecessorName = characters(99, 111, 100, 101, 116, 104, 105, 110, 103);
const incorrectBundleDomain = characters(99, 111, 109, 46, 115, 121, 110, 97, 114, 97);
const retiredFirstDisplayName = characters(84, 51, 67, 111, 100, 101);
const retiredFirstSpacedDisplayName = `${characters(84, 51)} Code`;
const retiredCompanyDisplayName = `${characters(84, 51)} ${characters(84, 111, 111, 108, 115)}`;

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const joinedWithOptionalSeparator = (left: string, right: string): string =>
  `${escapeRegExp(left)}[\\s._/@:-]*${escapeRegExp(right)}`;

const forbiddenPatterns = [
  new RegExp(
    joinedWithOptionalSeparator(retiredShortName, retiredFirstName.slice(retiredShortName.length)),
    "i",
  ),
  new RegExp(
    joinedWithOptionalSeparator(
      retiredShortName,
      retiredCompanyName.slice(retiredShortName.length),
    ),
    "i",
  ),
  new RegExp(
    joinedWithOptionalSeparator(retiredSecondName.slice(0, 2), retiredSecondName.slice(2)),
    "i",
  ),
  new RegExp(escapeRegExp(retiredPredecessorName), "i"),
  new RegExp(`@${escapeRegExp(retiredCompanyName)}`, "i"),
  new RegExp(
    `(?:^|[\\s"'\\x60./:@_-])${escapeRegExp(retiredShortName)}(?:$|[\\s"'\\x60./:@_-])`,
    "i",
  ),
  new RegExp(escapeRegExp(incorrectBundleDomain), "i"),
] as const;

interface ApprovedAttribution {
  readonly path: string;
  readonly line: string;
  readonly markdownSection?: string;
}

const approvedAttributions: readonly ApprovedAttribution[] = [
  {
    path: "LICENSE",
    line: `Copyright (c) 2026 ${retiredCompanyDisplayName} Inc.`,
  },
  {
    path: "README.md",
    markdownSection: "## Origins",
    line: `[${retiredFirstDisplayName}](https://github.com/pingdotgg/${retiredFirstName}), but Moss is now a separate product with its own`,
  },
  {
    path: "CHANGELOG.md",
    markdownSection: "## 0.7.0 - 2026-08-05",
    line: `**A review of the Moss codebase found an analytics configuration inherited from the original ${retiredFirstSpacedDisplayName} codebase when Moss was created as a clone in March. We did not add it, and we had no access to the PostHog project receiving the events.**`,
  },
  {
    path: "apps/web/src/whatsNew/entries.ts",
    line: `"A review of the Moss codebase found an analytics configuration inherited from the original ${retiredFirstSpacedDisplayName} codebase when Moss was created as a clone in March.",`,
  },
];

export interface BrandIdentityFile {
  readonly path: string;
  readonly contents: string;
}

export interface BrandIdentityViolation {
  readonly path: string;
  readonly line: number | null;
  readonly text: string;
}

export interface BrandIdentityBinaryFile {
  readonly path: string;
  readonly contents: Uint8Array;
}

export interface BrandIdentityRequirement {
  readonly path: string;
  readonly requiredText: readonly string[];
  readonly forbiddenText?: readonly string[];
}

const publicIdentityRequirements: readonly BrandIdentityRequirement[] = [
  {
    path: "apps/server/src/agentGateway/mcpInjection.ts",
    requiredText: ['MOSS_MCP_SERVER_NAME = "moss"', "[mcp_servers.${MOSS_MCP_SERVER_NAME}]"],
    forbiddenText: ['MCP_SERVER_NAME = "synara"', "[mcp_servers.synara]"],
  },
  {
    path: "apps/server/src/agentGateway/threadReadTools.ts",
    requiredText: ['name: "moss_context"', 'name: "moss_list_threads"'],
    forbiddenText: ['name: "synara_'],
  },
  {
    path: "apps/server/src/externalMcp/Layers/ExternalMcpGateway.ts",
    requiredText: ['name: "moss_overview"', 'name: "moss_create_task"'],
    forbiddenText: ['name: "synara_'],
  },
  {
    path: "apps/desktop/package.json",
    requiredText: ['"productName": "Moss"'],
    forbiddenText: ['"productName": "Synara"'],
  },
  {
    path: "packages/shared/src/desktopIdentity.ts",
    requiredText: [
      'MOSS_DESKTOP_SCHEME = "moss"',
      "MOSS_DESKTOP_ORIGIN = `${MOSS_DESKTOP_SCHEME}://app`",
      "MOSS_DESKTOP_ENTRY_URL = `${MOSS_DESKTOP_ORIGIN}/index.html`",
      'MOSS_DESKTOP_UPDATE_CHANNEL = "moss"',
      'MOSS_PRODUCTION_BUNDLE_ID = "com.moss.desktop"',
      "MOSS_DEVELOPMENT_BUNDLE_ID = `${MOSS_PRODUCTION_BUNDLE_ID}.dev`",
      "MOSS_CANARY_BUNDLE_ID = `${MOSS_PRODUCTION_BUNDLE_ID}.canary`",
      'displayName: "Moss"',
      'displayName: "Moss (Dev)"',
      'displayName: "Moss Canary"',
    ],
    forbiddenText: ["com.emanueledipietro.synara", 'MOSS_DESKTOP_SCHEME = "synara"'],
  },
  {
    path: "apps/desktop/src/main.ts",
    requiredText: [
      "desktopUpdateChannel(desktopFlavor)",
      "mossDesktopIdentity,",
      "resolveMossDesktopRuntimeFlavor",
      "const desktopIdentity = mossDesktopIdentity(desktopFlavor);",
      "const APP_DISPLAY_NAME = desktopIdentity.displayName;",
      "desktopIdentity.entryUrl",
    ],
    forbiddenText: ["MOSS_DESKTOP_ENTRY_URL", 'loadURL("synara://app"'],
  },
  {
    path: "apps/server/src/trustedOrigins.ts",
    requiredText: ["MOSS_DESKTOP_ORIGIN"],
    forbiddenText: ["synara://app"],
  },
  {
    path: "scripts/build-desktop-artifact.ts",
    requiredText: ["MOSS_PRODUCTION_BUNDLE_ID"],
    forbiddenText: ["com.emanueledipietro.synara"],
  },
  {
    path: "scripts/verify-packaged-desktop-startup.ts",
    requiredText: [
      "Expected one extracted Moss application executable",
      "MOSS_HOME: mossHome",
      "CODEX_HOME: codexHome",
      "MOSS_DESKTOP_USER_DATA_DIR: userData",
      'MOSS_DESKTOP_FLAVOR: options.executableName === "moss-beta" ? "beta" : "production"',
      'MOSS_DISABLE_SHELL_ENVIRONMENT_SYNC: "1"',
      "readPackagedStartupLogTails(logDirectory)",
    ],
    forbiddenText: ["Synara.exe"],
  },
  {
    path: "scripts/lib/brand-assets.ts",
    requiredText: [
      'productionMacIconPng: "apps/desktop/resources/icon.png"',
      'productionWindowsIconIco: "apps/desktop/resources/icon.ico"',
      'productionWebFaviconIco: "apps/web/public/favicon.ico"',
    ],
    forbiddenText: ["synara-black", "t3-black"],
  },
  {
    path: "apps/web/src/whatsNew/entries.ts",
    requiredText: [
      'title: "Moss, all the way through"',
      "The desktop bundle, renderer origin, update channel, icons, and visible product surfaces now use the Moss identity.",
    ],
    forbiddenText: ["com.emanueledipietro.synara", 'title: "Synara'],
  },
  {
    path: "apps/marketing/src/components/Navbar.tsx",
    requiredText: ['aria-label="Moss home"', 'alt=""', "Moss</span>"],
    forbiddenText: ["Synara"],
  },
];

const publicRuntimeRoots = [
  "apps/desktop/scripts",
  "apps/desktop/src",
  "apps/marketing/src",
  "apps/realtime-relay/src",
  "apps/server/scripts",
  "apps/server/src",
  "apps/web/src",
  "packages/contracts/src",
  "packages/shared/src",
] as const;

const runtimeSourceExtensions = new Set([
  ".astro",
  ".css",
  ".html",
  ".js",
  ".jsx",
  ".json",
  ".mjs",
  ".swift",
  ".ts",
  ".tsx",
]);

function collectPublicRuntimeFiles(root: string): BrandIdentityFile[] {
  const files: BrandIdentityFile[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "dist" && entry.name !== "test" && entry.name !== "__tests__")
          visit(path);
        continue;
      }
      if (!runtimeSourceExtensions.has(extname(entry.name))) continue;
      if (/\.(?:browser|test)\.[^.]+$/.test(entry.name)) continue;
      files.push({ path: relative(process.cwd(), path), contents: readFileSync(path, "utf8") });
    }
  };
  visit(root);
  return files;
}

// Exact provenance lines are allowed only on the website's contributor surfaces.
const runtimeAttributionLines: Readonly<Record<string, readonly string[]>> = {
  "apps/marketing/src/components/SiteFooter.tsx": [
    '<a href="https://github.com/Emanuele-web04/synara">Synara</a>',
  ],
  "apps/marketing/src/app/sponsor/page.tsx": [
    '<a className="underline" href="https://github.com/Emanuele-web04/synara">',
    "Synara and its contributors",
  ],
  "apps/marketing/src/app/sponsors/page.tsx": [
    '<a className="underline" href="https://github.com/Emanuele-web04/synara">',
    "Synara and its contributors",
  ],
};

const upstreamReleaseHistory =
  "Upstream release history: Synara 1.0.0 is a Stable release. Hubs and the Tasks to-do list remain exclusive to Synara Beta, with separate data and update feeds. Stable does not send Beta diagnostics.";

// Compatibility is not product identity. Each reviewed exception permits one
// exact line in one file, with the current writer/consumer required alongside
// it. Never allow entire files or a pattern matching retired identifiers.
const runtimeLegacyReadExceptions: readonly {
  path: string;
  line: string;
  rationale: string;
  requiredText: readonly string[];
  forbiddenUsage?: RegExp;
}[] = [
  {
    path: "packages/contracts/src/inlineVisual.ts",
    line: 'export const INLINE_VISUAL_EMBED_FENCE_UPSTREAM_ALIAS = "synara-visual";',
    rationale: "Read historical visual placement fences; new replies use the current fence.",
    requiredText: ['export const INLINE_VISUAL_EMBED_FENCE = "moss-visual";'],
  },
  {
    path: "packages/shared/src/inlineVisual.ts",
    line: 'const LEGACY_SCROLL_INTENT_METHOD = "synara/notifications/scroll-intent";',
    rationale: "Read already mounted historical frames while new frames emit the current method.",
    requiredText: [
      'const SCROLL_INTENT_METHOD = "moss/notifications/scroll-intent";',
      "case LEGACY_SCROLL_INTENT_METHOD:",
      "JSON.stringify(SCROLL_INTENT_METHOD)",
    ],
  },
  {
    path: "packages/shared/src/inlineVisual.ts",
    line: 'const LEGACY_STOPPED_METHOD = "synara/notifications/visual-stopped";',
    rationale: "Read historical sandbox stop notices while new frames emit the current method.",
    requiredText: [
      'const STOPPED_METHOD = "moss/notifications/visual-stopped";',
      "case LEGACY_STOPPED_METHOD:",
      "JSON.stringify(STOPPED_METHOD)",
    ],
  },
  {
    path: "apps/server/src/orchestration/Layers/ProviderCommandReactor.ts",
    line: "const legacyTimeout = env.SYNARA_PRE_TURN_BASELINE_TIMEOUT_MS;",
    rationale: "Read existing operator overrides; the current environment name has precedence.",
    requiredText: ["env.MOSS_PRE_TURN_BASELINE_TIMEOUT_MS ?? legacyTimeout"],
  },
  {
    path: "apps/server/src/provider/openCodeV2Client.ts",
    line: 'const LEGACY_INSTRUCTION_KEY = "synara";',
    rationale:
      "Read and remove only the former app-owned OpenCode entry after writing the current key.",
    requiredText: [
      'key: "moss", value: prompt.system',
      "entry.key === LEGACY_INSTRUCTION_KEY",
      "native.session.instructions.entry.remove(",
    ],
    forbiddenUsage: /\.put\([^)]*\bkey:\s*LEGACY_INSTRUCTION_KEY/,
  },
  {
    path: "apps/web/src/components/ChatMarkdown.tsx",
    line: 'href: [...(defaultSchema.protocols?.href ?? []), "file", "thread", "moss", "synara"],',
    rationale: "Read historical conversation links while supporting current product links.",
    requiredText: ["const AUTHORED_HTML_SCHEMA"],
  },
  {
    path: "apps/desktop/src/backendIssueDetector.ts",
    line: 'const LEGACY_DIAGNOSTIC_ISSUE_PREFIX = "SYNARA_DIAGNOSTIC_ISSUE ";',
    rationale:
      "The desktop reader accepts old backend reports; the shared emitter prefix is current.",
    requiredText: [
      "DESKTOP_DIAGNOSTIC_ISSUE_PREFIX,",
      "LEGACY_DIAGNOSTIC_ISSUE_PREFIX",
      "state.line.startsWith(prefix)",
    ],
    forbiddenUsage: /(?:write|emit)\([^)]*LEGACY_DIAGNOSTIC_ISSUE_PREFIX/,
  },
  {
    path: "apps/web/src/whatsNew/entries.ts",
    line: `"${upstreamReleaseHistory}",`,
    rationale: "Preserve the factual upstream release history without assigning it to Moss.",
    requiredText: ['version: "1.0.0"'],
  },
  {
    path: "apps/web/src/localization/zhCNWhatsNew.ts",
    line: `"${upstreamReleaseHistory}":`,
    rationale: "Translation lookup for the exact upstream historical attribution.",
    requiredText: ["上游发布历史："],
  },
  {
    path: "apps/web/src/localization/zhCNWhatsNew.ts",
    line: '"上游发布历史：Synara 1.0.0 是 Stable 版本。Hubs 和 Tasks 待办列表仍为 Synara Beta 专属，数据和更新源各自独立。Stable 不会发送 Beta 诊断数据。",',
    rationale: "Exact localized upstream release attribution.",
    requiredText: [upstreamReleaseHistory],
  },
];

// These identifiers may appear only at reviewed reader sites. Checking every
// occurrence also catches aliases in new writers and computed property writes.
const runtimeLegacyVisualReaderLines: Readonly<
  Record<string, Readonly<Record<string, readonly string[]>>>
> = {
  INLINE_VISUAL_EMBED_FENCE_UPSTREAM_ALIAS: {
    "packages/contracts/src/inlineVisual.ts": [
      'export const INLINE_VISUAL_EMBED_FENCE_UPSTREAM_ALIAS = "synara-visual";',
    ],
    "packages/shared/src/inlineVisual.ts": [
      "INLINE_VISUAL_EMBED_FENCE_UPSTREAM_ALIAS,",
      '"(?:" + INLINE_VISUAL_EMBED_FENCE + "|" + INLINE_VISUAL_EMBED_FENCE_UPSTREAM_ALIAS + ")";',
      "!text.includes(INLINE_VISUAL_EMBED_FENCE_UPSTREAM_ALIAS)",
    ],
    "apps/web/src/components/ChatMarkdown.tsx": [
      "INLINE_VISUAL_EMBED_FENCE_UPSTREAM_ALIAS,",
      "rawFenceInfo === INLINE_VISUAL_EMBED_FENCE_UPSTREAM_ALIAS) &&",
    ],
  },
  LEGACY_SCROLL_INTENT_METHOD: {
    "packages/shared/src/inlineVisual.ts": [
      'const LEGACY_SCROLL_INTENT_METHOD = "synara/notifications/scroll-intent";',
      "case LEGACY_SCROLL_INTENT_METHOD:",
    ],
  },
  LEGACY_STOPPED_METHOD: {
    "packages/shared/src/inlineVisual.ts": [
      'const LEGACY_STOPPED_METHOD = "synara/notifications/visual-stopped";',
      "case LEGACY_STOPPED_METHOD:",
    ],
  },
};

export function findPublicRuntimeBrandViolations(
  files: readonly BrandIdentityFile[],
): BrandIdentityViolation[] {
  const violations: BrandIdentityViolation[] = [];
  const legacyVisualReaders = Object.entries(runtimeLegacyVisualReaderLines).map(
    ([identifier, readers]) => ({ pattern: new RegExp(`\\b${identifier}\\b`), readers }),
  );
  for (const originalFile of files) {
    const file = { ...originalFile, path: originalFile.path.replaceAll("\\", "/") };
    const consumedAttributions = new Set<string>();
    for (const [index, line] of file.contents.split(/\r?\n/).entries()) {
      const trimmed = line.trim();
      for (const { pattern, readers } of legacyVisualReaders) {
        if (pattern.test(line) && !readers[file.path]?.includes(trimmed)) {
          violations.push({
            path: file.path,
            line: index + 1,
            text: "Historical visual identifier is used outside its reviewed reader sites.",
          });
        }
      }
      const reviewedLegacyRead = runtimeLegacyReadExceptions.some(
        (exception) =>
          exception.path === file.path &&
          exception.line === trimmed &&
          exception.requiredText.every((text) => file.contents.includes(text)) &&
          !exception.forbiddenUsage?.test(file.contents),
      );
      if (
        !consumedAttributions.has(trimmed) &&
        (runtimeAttributionLines[file.path]?.includes(trimmed) || reviewedLegacyRead)
      ) {
        consumedAttributions.add(trimmed);
        continue;
      }
      // The actual Moss repository retains this historical coordinate. The
      // `@synara/` workspace package scope is the sanctioned post-merge
      // scope, not the retired product name.
      const identityText = (
        file.path.startsWith("apps/marketing/")
          ? line
              .replaceAll("https://github.com/Zluowa/moss-synara", "")
              .replaceAll("https://api.github.com/repos/Zluowa/moss-synara", "")
          : line
      )
        .replaceAll("@synara/", "")
        // "moss-synara" is the factual wire identity of the Moss <-> Moss Canvas
        // bridge; the companion app (moss-canvas) already implements against it.
        .replaceAll('"moss-synara"', "");
      if (!/synara/i.test(identityText)) continue;
      violations.push({
        path: file.path,
        line: index + 1,
        text: "Retired product identifier is present in native Moss runtime source.",
      });
    }
  }
  return violations;
}

function containsForbiddenIdentity(value: string): boolean {
  return forbiddenPatterns.some((pattern) => pattern.test(value));
}

function findApprovedAttribution(
  path: string,
  line: string,
  markdownSection: string | null,
  consumedAttributions: ReadonlySet<number>,
): number | null {
  const index = approvedAttributions.findIndex(
    (attribution, candidateIndex) =>
      !consumedAttributions.has(candidateIndex) &&
      attribution.path === path &&
      attribution.line === line.trim() &&
      (attribution.markdownSection === undefined ||
        attribution.markdownSection === markdownSection),
  );
  return index === -1 ? null : index;
}

export function findLegacyIdentityViolations(
  files: readonly BrandIdentityFile[],
): BrandIdentityViolation[] {
  const violations: BrandIdentityViolation[] = [];
  for (const file of files) {
    if (containsForbiddenIdentity(file.path)) {
      violations.push({ path: file.path, line: null, text: file.path });
    }
    const consumedAttributions = new Set<number>();
    let markdownSection: string | null = null;
    for (const [index, line] of file.contents.split(/\r?\n/).entries()) {
      if (/^#{1,2}\s+/.test(line)) markdownSection = line.trim();
      if (!containsForbiddenIdentity(line)) continue;
      const approvedAttribution = findApprovedAttribution(
        file.path,
        line,
        markdownSection,
        consumedAttributions,
      );
      if (approvedAttribution !== null) {
        consumedAttributions.add(approvedAttribution);
        continue;
      }
      violations.push({ path: file.path, line: index + 1, text: line.trim() });
    }
  }
  return violations;
}

const approvedMossAssetDigests = new Map<string, string>([
  [
    "apps/desktop/resources/icon.png",
    "6a31d902b947494ac3a408c786acdaa80d36a9942996fa00cd6ce1e4000e95ea",
  ],
  [
    "apps/desktop/resources/icon.ico",
    "e5f951a68b13e5dc425bbb16c1d2b35aede48f692e70a81089213f57ba80666a",
  ],
  [
    "apps/web/public/apple-touch-icon.png",
    "08a421fdee25d66e3a8b0d2669111f08e485bd67229d2c9a7e085c914fbd12f2",
  ],
  [
    "apps/web/public/favicon.ico",
    "e5f951a68b13e5dc425bbb16c1d2b35aede48f692e70a81089213f57ba80666a",
  ],
  // Raster screenshots cannot be searched for embedded text. The marketing
  // captures use sample conversation data and were visually reviewed on 2026-09-06.
  [
    "apps/marketing/public/moss-workspace.png",
    "8631783dac808c06033df9db19527f0699c8dad660ba5ac7f37c92f85296c335",
  ],
  [
    "apps/marketing/public/moss-workspace-dark.png",
    "5256c855e7bf872f02b802b2c14f9ee2294f518ac999e07526d8a01d25a7db6e",
  ],
  [
    "assets/prod/readme-screenshot.jpeg",
    "0b4be139f13dd08885a1aac26fc1f7c623697db157777d16360e985c93d47bcf",
  ],
]);

function findLine(contents: string, value: string): number | null {
  const offset = contents.indexOf(value);
  if (offset < 0) return null;
  return contents.slice(0, offset).split(/\r?\n/).length;
}

export function findBrandIdentityViolations(
  files: readonly BrandIdentityFile[],
  requirements: readonly BrandIdentityRequirement[] = publicIdentityRequirements,
): BrandIdentityViolation[] {
  const filesByPath = new Map(files.map((file) => [file.path, file]));
  const violations: BrandIdentityViolation[] = [];

  for (const requirement of requirements) {
    const file = filesByPath.get(requirement.path);
    if (!file) {
      violations.push({
        path: requirement.path,
        line: null,
        text: "Required public identity file is missing.",
      });
      continue;
    }

    for (const value of requirement.requiredText) {
      if (file.contents.includes(value)) continue;
      violations.push({
        path: requirement.path,
        line: null,
        text: `Missing required Moss identity text: ${value}`,
      });
    }
    for (const value of requirement.forbiddenText ?? []) {
      if (!file.contents.includes(value)) continue;
      violations.push({
        path: requirement.path,
        line: findLine(file.contents, value),
        text: `Retired public identity text is present: ${value}`,
      });
    }
  }

  return violations;
}

export function findVisualBrandAssetViolations(
  files: readonly BrandIdentityBinaryFile[],
  approvedDigests: ReadonlyMap<string, string> = approvedMossAssetDigests,
): BrandIdentityViolation[] {
  const filesByPath = new Map(files.map((file) => [file.path, file]));
  const violations: BrandIdentityViolation[] = [];
  for (const [path, approvedDigest] of approvedDigests) {
    const file = filesByPath.get(path);
    if (!file) {
      violations.push({ path, line: null, text: "Required Moss brand asset is missing." });
      continue;
    }
    const digest = createHash("sha256").update(file.contents).digest("hex");
    if (digest !== approvedDigest) {
      violations.push({
        path,
        line: null,
        text: "Moss brand asset changed; perform a visual identity review before approving it.",
      });
    }
  }
  return violations;
}

function main(): void {
  const textFiles = publicIdentityRequirements.map(({ path }) => ({
    path,
    contents: readFileSync(path, "utf8"),
  }));
  const binaryFiles = [...approvedMossAssetDigests.keys()].map((path) => ({
    path,
    contents: readFileSync(path),
  }));
  const reviewedAttributionFiles = ["LICENSE", "README.md"].map((path) => ({
    path,
    contents: readFileSync(path, "utf8"),
  }));
  const violations = [
    ...findBrandIdentityViolations(textFiles),
    ...findPublicRuntimeBrandViolations(publicRuntimeRoots.flatMap(collectPublicRuntimeFiles)),
    ...findLegacyIdentityViolations(reviewedAttributionFiles),
    ...findVisualBrandAssetViolations(binaryFiles),
  ];
  if (violations.length === 0) {
    console.log("Moss identity check passed.");
    return;
  }

  console.error("Moss public identity check failed:");
  for (const violation of violations) {
    const location =
      violation.line === null ? violation.path : `${violation.path}:${violation.line}`;
    console.error(`- ${location}: ${violation.text}`);
  }
  process.exitCode = 1;
}

if (import.meta.main) main();
