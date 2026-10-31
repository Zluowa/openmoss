// FILE: check-brand-identity.ts
// Purpose: Locks Moss's native product identity while isolating factual upstream coordinates.

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
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

// The start of the old Y-shaped mark's path data, which a Moss-named file can still carry.
const retiredMarkDrawing = "M2.65188 2.1899";

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
    // The author becomes the installer's publisher and copyright line.
    requiredText: ["MOSS_PRODUCTION_BUNDLE_ID", 'author: "Moss"'],
    forbiddenText: ["com.emanueledipietro.synara", "Emanuele Di Pietro"],
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
  "apps/cloudflare-apimart-egress/src",
  "apps/cloudflare-model-gateway/src",
  "apps/cloudflare-realtime-relay/src",
  "apps/desktop/scripts",
  "apps/desktop/src",
  "apps/marketing/content",
  "apps/marketing/src",
  "apps/realtime-relay/src",
  "apps/server/scripts",
  "apps/server/src",
  "apps/share-relay/src",
  "apps/sms-relay/src",
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
  ".mdx",
  ".mjs",
  ".svg",
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
    if (/synara/i.test(file.path)) {
      violations.push({
        path: file.path,
        line: null,
        text: "Retired product name is in a file name.",
      });
    }
    if (file.contents.includes(retiredMarkDrawing)) {
      violations.push({
        path: file.path,
        line: findLine(file.contents, retiredMarkDrawing),
        text: "Retired logo drawing is present; the Moss mark is the coral pinwheel.",
      });
    }
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
      if (!consumedAttributions.has(trimmed) && reviewedLegacyRead) {
        consumedAttributions.add(trimmed);
        continue;
      }
      // The actual Moss repository retains this historical coordinate. The
      // `@synara/` workspace package scope is the sanctioned post-merge
      // scope, not the retired product name.
      const identityText = (
        file.path.startsWith("apps/marketing/") || file.path === "README.md"
          ? line
              .replaceAll("https://github.com/Zluowa/moss-synara", "")
              .replaceAll("https://api.github.com/repos/Zluowa/moss-synara", "")
          : line
      )
        .replaceAll("@synara/", "")
        // "moss-synara" is the factual wire identity of the Moss <-> Moss Canvas
        // bridge; the companion app (moss-canvas) already implements against it.
        .replaceAll('"moss-synara"', "");
      // The upstream author's name counts too: it reaches signing identifiers and installer metadata.
      if (!/synara|emanuele/i.test(identityText)) continue;
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
  // Looked at on 2026-10-31: every image here draws the Moss mark or is unrelated to the brand.
  [
    "apps/desktop/resources/app-icon-linux.png",
    "7bafe8cb1d2cd3efccb2bf8927f140e4e36f0262a2c07a5ca2c190ad79cd940f",
  ],
  [
    "apps/desktop/resources/app-icon-macos.png",
    "7bafe8cb1d2cd3efccb2bf8927f140e4e36f0262a2c07a5ca2c190ad79cd940f",
  ],
  [
    "apps/desktop/resources/app-icon-windows.ico",
    "e01149655bd6d3b5dd80d0f524b2ca8e3784254c61f4219f3e8e4984dc964ae3",
  ],
  [
    "apps/desktop/resources/dock-icon-dark.png",
    "3fe7b40d302763fea0bda33dcf311de34963db4a24a1867720a8e9cccd788470",
  ],
  [
    "apps/desktop/resources/dock-icon-moss-black.png",
    "7bafe8cb1d2cd3efccb2bf8927f140e4e36f0262a2c07a5ca2c190ad79cd940f",
  ],
  [
    "apps/desktop/resources/dock-icon-moss-coral.png",
    "6a31d902b947494ac3a408c786acdaa80d36a9942996fa00cd6ce1e4000e95ea",
  ],
  [
    "apps/desktop/resources/dock-icon.png",
    "6a31d902b947494ac3a408c786acdaa80d36a9942996fa00cd6ce1e4000e95ea",
  ],
  [
    "apps/desktop/resources/icon.icns",
    "589b3262fd16f0d77f7ffa6bf013e6f0eaa7b889b4d68f0fe306abd76f0d2806",
  ],
  [
    "apps/desktop/resources/moss.png",
    "6a31d902b947494ac3a408c786acdaa80d36a9942996fa00cd6ce1e4000e95ea",
  ],
  [
    "apps/marketing/public/apple-touch-icon.png",
    "08a421fdee25d66e3a8b0d2669111f08e485bd67229d2c9a7e085c914fbd12f2",
  ],
  [
    "apps/marketing/public/favicon-16x16.png",
    "d3fb9746d86d6fbbcfdc33eea17b151ae28b9ebae12b72501326a7561a5ad8d3",
  ],
  [
    "apps/marketing/public/favicon-32x32.png",
    "df82a20cc1f53256f6639c7293638b7b7c99f82c37ff048d9f785c9c05cde7c3",
  ],
  [
    "apps/marketing/public/favicon.ico",
    "e5f951a68b13e5dc425bbb16c1d2b35aede48f692e70a81089213f57ba80666a",
  ],
  [
    "apps/marketing/public/hero-bg.jpg",
    "09f05c61e29b1a68a5f0db24dafa7407b3a3f158e2d18c5feff6a195740c747b",
  ],
  [
    "apps/marketing/public/icon.png",
    "6a31d902b947494ac3a408c786acdaa80d36a9942996fa00cd6ce1e4000e95ea",
  ],
  [
    "apps/marketing/public/moss-app-icon-black.png",
    "7bafe8cb1d2cd3efccb2bf8927f140e4e36f0262a2c07a5ca2c190ad79cd940f",
  ],
  [
    "apps/marketing/public/moss-app-icon-coral.png",
    "6a31d902b947494ac3a408c786acdaa80d36a9942996fa00cd6ce1e4000e95ea",
  ],
  [
    "apps/marketing/public/moss-icon.png",
    "6a31d902b947494ac3a408c786acdaa80d36a9942996fa00cd6ce1e4000e95ea",
  ],
  [
    "apps/web/public/favicon-16x16.png",
    "d3fb9746d86d6fbbcfdc33eea17b151ae28b9ebae12b72501326a7561a5ad8d3",
  ],
  [
    "apps/web/public/favicon-32x32.png",
    "df82a20cc1f53256f6639c7293638b7b7c99f82c37ff048d9f785c9c05cde7c3",
  ],
  [
    "apps/web/public/moss-app-icon-black.png",
    "7bafe8cb1d2cd3efccb2bf8927f140e4e36f0262a2c07a5ca2c190ad79cd940f",
  ],
  [
    "apps/web/public/moss-app-icon-coral.png",
    "6a31d902b947494ac3a408c786acdaa80d36a9942996fa00cd6ce1e4000e95ea",
  ],
  [
    "apps/web/public/moss-icon.png",
    "6a31d902b947494ac3a408c786acdaa80d36a9942996fa00cd6ce1e4000e95ea",
  ],
  [
    "apps/web/public/moss-logo-black.png",
    "0814d21c70570abd97bd6bdcb72102a7cd183e85250418e14427fdfaa3773b4f",
  ],
  [
    "apps/web/public/moss-logo-coral.png",
    "4108fb0bef47257800629cf253d38b7713582bcdd52fc371098e64b85ce3c4e8",
  ],
  [
    "apps/web/public/moss-logo-mask.png",
    "f209f898e1aaa5aa9b241be8a50bc2f4077e830d59992fb52a6205ba30417ea8",
  ],
  [
    "apps/web/public/app-icons/beta.png",
    "58d853611e8485ec81197cbcb09f270b56c962c9271d1255eecaec4a86b55e03",
  ],
  [
    "apps/web/public/app-icons/dark.png",
    "eca1b1d8af379aaa96d5693bf3d9fab1d6ddaeee159f8952f0cb947e71dcba04",
  ],
  [
    "apps/web/public/app-icons/default.png",
    "6a31d902b947494ac3a408c786acdaa80d36a9942996fa00cd6ce1e4000e95ea",
  ],
  [
    "apps/web/public/app-icons/icon-group-600-macos.png",
    "1cf4b53aa6e646ea56a6e2cccf5952d7f159764ac3ac35664ec0021ef2902821",
  ],
  [
    "apps/web/public/app-icons/safari.png",
    "ecd4f1f1bddd88c65275bd0fba70620645b9317644c85587cf1563dda01d57e2",
  ],
  [
    "assets/beta/beta-macos-1024.png",
    "21dce04e0769b1cb9b24a4ddbd683bc089a5167b06371902af65b3e2628ce731",
  ],
  [
    "assets/beta/beta-macos-legacy-1024.png",
    "21dce04e0769b1cb9b24a4ddbd683bc089a5167b06371902af65b3e2628ce731",
  ],
  [
    "assets/beta/beta-universal-1024.png",
    "d8280805052d32a49971871be829612d04eedd6650f285964a7b9b811336badb",
  ],
  [
    "assets/beta/beta-web-apple-touch-180.png",
    "3f1fac86cc3986b48d4e3aeb72a29b538f3d5acd94b9cbab577f7dc8ff79b799",
  ],
  [
    "assets/beta/beta-web-favicon-16x16.png",
    "5fd3cb639a1247465ad192d5fbe4531063d94b96fee1ff1c0368fff9bd43949b",
  ],
  [
    "assets/beta/beta-web-favicon-32x32.png",
    "2081c034bcabf85ec0e4e5e2001f51840f34467f81f8efad00474bd95615d2f5",
  ],
  [
    "assets/beta/beta-web-favicon.ico",
    "24b665fc6d67eab693ea2c0bbf04412e78c17a8a4b814a865f02b8285596b66f",
  ],
  [
    "assets/beta/beta-windows.ico",
    "94eeaa2f495365d7a05dd36ee50a0feb6d8b61e80a0df54e28212de30023ffd6",
  ],
  [
    "assets/dev/blueprint-ios-1024.png",
    "4c1590acfaf15724e639486afdfa3bdddfeb4c07d7b1ee99107eff79b59013c7",
  ],
  [
    "assets/dev/blueprint-macos-1024.png",
    "4c1590acfaf15724e639486afdfa3bdddfeb4c07d7b1ee99107eff79b59013c7",
  ],
  [
    "assets/dev/blueprint-universal-1024.png",
    "4c1590acfaf15724e639486afdfa3bdddfeb4c07d7b1ee99107eff79b59013c7",
  ],
  [
    "assets/dev/blueprint-web-apple-touch-180.png",
    "bb7da2113b1c6113ff584fe42739c8a8a53271d35f51fdd8306c5da712f3a87d",
  ],
  [
    "assets/dev/blueprint-web-favicon-16x16.png",
    "b0646cdcbd402e7edb6d079a8ef521f792faee95d9615e9444609d078435d037",
  ],
  [
    "assets/dev/blueprint-web-favicon-32x32.png",
    "75ac93a5430409d5c5dd16786847211fe2605181d1678e62a559f981034ac88a",
  ],
  [
    "assets/dev/blueprint-web-favicon.ico",
    "03a050a1f690d2c7b38974ac63ac8d8252d870683053cad11af1e44418f2a320",
  ],
  [
    "assets/dev/blueprint-windows.ico",
    "6cc76775e0580dfd48c71b417ef2424c88b9301d3020eabaa7ed15f65b55ce6f",
  ],
]);

// A file name says nothing about what an image draws, and this script cannot look inside one. So
// every image in these folders needs a digest above: adding or changing one means someone looked
// at it. Top level only; each folder holds brand artwork rather than product content.
const reviewedBrandImageDirectories = [
  "apps/desktop/resources",
  "apps/marketing/public",
  "apps/web/public",
  "apps/web/public/app-icons",
  "assets/beta",
  "assets/dev",
] as const;
const brandImageExtensions = new Set([".gif", ".icns", ".ico", ".jpeg", ".jpg", ".png", ".webp"]);

function collectBrandImagePaths(): string[] {
  return reviewedBrandImageDirectories.flatMap((directory) =>
    readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && brandImageExtensions.has(extname(entry.name)))
      .map((entry) => `${directory}/${entry.name}`),
  );
}

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

export function findUnreviewedBrandImages(
  paths: readonly string[],
  approvedDigests: ReadonlyMap<string, string> = approvedMossAssetDigests,
): BrandIdentityViolation[] {
  return paths
    .filter((path) => !approvedDigests.has(path))
    .map((path) => ({
      path,
      line: null,
      text: "Brand image has no reviewed digest; look at it, then add its digest.",
    }));
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
  // The public mirror leaves out the website and carries its own README, so most of what this
  // check holds to account is not there.
  if (!existsSync("apps/marketing/src")) {
    console.log("Moss identity check skipped: this is not the full repository.");
    return;
  }
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
    ...findPublicRuntimeBrandViolations([
      ...publicRuntimeRoots.flatMap(collectPublicRuntimeFiles),
      ...reviewedAttributionFiles.filter(({ path }) => path === "README.md"),
    ]),
    ...findLegacyIdentityViolations(reviewedAttributionFiles),
    ...findVisualBrandAssetViolations(binaryFiles),
    ...findUnreviewedBrandImages(collectBrandImagePaths()),
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
