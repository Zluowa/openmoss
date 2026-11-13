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
      // The actual Moss repository retains this historical coordinate.
      const identityText = (
        file.path.startsWith("apps/marketing/") || file.path === "README.md"
          ? line
              .replaceAll("https://github.com/Zluowa/moss-synara", "")
              .replaceAll("https://api.github.com/repos/Zluowa/moss-synara", "")
          : line
      )
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
    "d88a5cee2808e7cb23dffc7bb2b0f614b858f44d4ec93b76b9ed99ef88f21323",
  ],
  [
    "apps/desktop/resources/icon.ico",
    "3d38c12ff9c33883782de02217e25c7a533e194b741162450778765efcda9a89",
  ],
  [
    "apps/web/public/apple-touch-icon.png",
    "084f08c1213b07908b56b3899f552b2c5a95b860836bdf0dfb3da766ac24092f",
  ],
  [
    "apps/web/public/favicon.ico",
    "6d1a7729984f339b17536d6b6dbea83a4755d86e0eae04ed0a31f1cf24904df0",
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
    "3dae8ce3fcfd2661d24670e6dcca7c6051a57e0369b1fbdbc600d5af3b8293e6",
  ],
  [
    "apps/desktop/resources/app-icon-macos.png",
    "3dae8ce3fcfd2661d24670e6dcca7c6051a57e0369b1fbdbc600d5af3b8293e6",
  ],
  [
    "apps/desktop/resources/app-icon-windows.ico",
    "1a7e72ee34aa3060d6cfa19100bdc8a47b0558d87db511672deb20b2cc7bce77",
  ],
  [
    "apps/desktop/resources/dock-icon-dark.png",
    "8680cc3806c07b2068d495b0722ab38f9db71aa0a89d81c511610b2adbebf34e",
  ],
  [
    "apps/desktop/resources/dock-icon-moss-black.png",
    "3dae8ce3fcfd2661d24670e6dcca7c6051a57e0369b1fbdbc600d5af3b8293e6",
  ],
  [
    "apps/desktop/resources/dock-icon-moss-coral.png",
    "d88a5cee2808e7cb23dffc7bb2b0f614b858f44d4ec93b76b9ed99ef88f21323",
  ],
  [
    "apps/desktop/resources/dock-icon.png",
    "d88a5cee2808e7cb23dffc7bb2b0f614b858f44d4ec93b76b9ed99ef88f21323",
  ],
  [
    "apps/desktop/resources/icon.icns",
    "4b9d680b7c0b498f357de901cf079525c10833a742b171875bd1b5c474838623",
  ],
  [
    "apps/desktop/resources/moss.png",
    "d88a5cee2808e7cb23dffc7bb2b0f614b858f44d4ec93b76b9ed99ef88f21323",
  ],
  [
    "apps/marketing/public/apple-touch-icon.png",
    "084f08c1213b07908b56b3899f552b2c5a95b860836bdf0dfb3da766ac24092f",
  ],
  [
    "apps/marketing/public/favicon-16x16.png",
    "8d9e9120168dd0cecdae7aedca469d18bd75137784aa483aeebee5117dd61c40",
  ],
  [
    "apps/marketing/public/favicon-32x32.png",
    "339fc11c2de7a9ac7a9809d60d64d373722ebf7a74e0ac6f4d11fdbcba050b40",
  ],
  [
    "apps/marketing/public/favicon.ico",
    "6d1a7729984f339b17536d6b6dbea83a4755d86e0eae04ed0a31f1cf24904df0",
  ],
  [
    "apps/marketing/public/hero-bg.jpg",
    "09f05c61e29b1a68a5f0db24dafa7407b3a3f158e2d18c5feff6a195740c747b",
  ],
  [
    "apps/marketing/public/icon.png",
    "d88a5cee2808e7cb23dffc7bb2b0f614b858f44d4ec93b76b9ed99ef88f21323",
  ],
  [
    "apps/marketing/public/moss-app-icon-black.png",
    "3dae8ce3fcfd2661d24670e6dcca7c6051a57e0369b1fbdbc600d5af3b8293e6",
  ],
  [
    "apps/marketing/public/moss-app-icon-coral.png",
    "d88a5cee2808e7cb23dffc7bb2b0f614b858f44d4ec93b76b9ed99ef88f21323",
  ],
  [
    "apps/marketing/public/moss-icon.png",
    "d88a5cee2808e7cb23dffc7bb2b0f614b858f44d4ec93b76b9ed99ef88f21323",
  ],
  [
    "apps/web/public/favicon-16x16.png",
    "8d9e9120168dd0cecdae7aedca469d18bd75137784aa483aeebee5117dd61c40",
  ],
  [
    "apps/web/public/favicon-32x32.png",
    "339fc11c2de7a9ac7a9809d60d64d373722ebf7a74e0ac6f4d11fdbcba050b40",
  ],
  [
    "apps/web/public/moss-app-icon-black.png",
    "3dae8ce3fcfd2661d24670e6dcca7c6051a57e0369b1fbdbc600d5af3b8293e6",
  ],
  [
    "apps/web/public/moss-app-icon-coral.png",
    "d88a5cee2808e7cb23dffc7bb2b0f614b858f44d4ec93b76b9ed99ef88f21323",
  ],
  [
    "apps/web/public/moss-icon.png",
    "d88a5cee2808e7cb23dffc7bb2b0f614b858f44d4ec93b76b9ed99ef88f21323",
  ],
  [
    "apps/web/public/moss-logo-black.png",
    "9777ab2f8d3cc6840e7265dd91c1498a9f65f914530f9afe1d0d706aa786fc7a",
  ],
  [
    "apps/web/public/moss-logo-coral.png",
    "731cb64be5c7d8b888805deb1e749e6c51f3d0022fdbb07c43082276baf72b6b",
  ],
  [
    "apps/web/public/moss-logo-mask.png",
    "bc06ad927f4e1727cd09709633a504314aae8329a4b4eaf2a125ba2ad5a8cd79",
  ],
  [
    "apps/web/public/app-icons/beta.png",
    "7b682348bd50ebfeff0441305c1f5fbf27d8a42e5134d84d24b872096da33f98",
  ],
  [
    "apps/web/public/app-icons/dark.png",
    "b296ec0783e74cb53702f9d9ef64ba8ddda7a3c247a1e2801b429687e6decd43",
  ],
  [
    "apps/web/public/app-icons/default.png",
    "d88a5cee2808e7cb23dffc7bb2b0f614b858f44d4ec93b76b9ed99ef88f21323",
  ],
  [
    "apps/web/public/app-icons/icon-group-600-macos.png",
    "73d0ad6f93b619a77ffbb17d7c8b3fc1ea071329f36fb09b4f34f696a6d896e4",
  ],
  [
    "apps/web/public/app-icons/safari.png",
    "ecd4f1f1bddd88c65275bd0fba70620645b9317644c85587cf1563dda01d57e2",
  ],
  [
    "assets/beta/beta-macos-1024.png",
    "99ab58e943b6b89971447ecf13de2f72f92609c0b7bfa34eb0adf1a573821236",
  ],
  [
    "assets/beta/beta-macos-legacy-1024.png",
    "99ab58e943b6b89971447ecf13de2f72f92609c0b7bfa34eb0adf1a573821236",
  ],
  [
    "assets/beta/beta-universal-1024.png",
    "8d8008a097ae13354a160128e9b04a1b88549f5da6697e7f5fbedea94da1442b",
  ],
  [
    "assets/beta/beta-web-apple-touch-180.png",
    "5859a11c8e9a48afc20938496ad68cd6388cd18fe82004aef60d5fed5a0edef4",
  ],
  [
    "assets/beta/beta-web-favicon-16x16.png",
    "843f2ee75090aed6c56bc93b6394aca8f6e989dcaa42caa7c0f69403e480b018",
  ],
  [
    "assets/beta/beta-web-favicon-32x32.png",
    "06e31c902c637c2a556e4bb770c29811377f31da1fcc923f2a643b02d549b8b9",
  ],
  [
    "assets/beta/beta-web-favicon.ico",
    "b37eed99358d4fee87c9fe2b04726cca1ad32105269b343c62116bd19ff4be09",
  ],
  [
    "assets/beta/beta-windows.ico",
    "23a607c8a0950177d12af186f1b44ddfa3f99f9c4d311f2b268f43b9dbebfbc2",
  ],
  [
    "assets/dev/blueprint-ios-1024.png",
    "2a04d775ec5f864e291332721c37094b4ce2f5b016590ab74fba3c8e1280d051",
  ],
  [
    "assets/dev/blueprint-macos-1024.png",
    "2a04d775ec5f864e291332721c37094b4ce2f5b016590ab74fba3c8e1280d051",
  ],
  [
    "assets/dev/blueprint-universal-1024.png",
    "2a04d775ec5f864e291332721c37094b4ce2f5b016590ab74fba3c8e1280d051",
  ],
  [
    "assets/dev/blueprint-web-apple-touch-180.png",
    "6256f048e7fa1998f2fc8c7eba8157283e7a9e9aff8bdc057af6b2edaa62926a",
  ],
  [
    "assets/dev/blueprint-web-favicon-16x16.png",
    "bde941d7d5a6d6b60e4a5bdbaf147da985b67e7ca2a50f66195d01f3030482de",
  ],
  [
    "assets/dev/blueprint-web-favicon-32x32.png",
    "0f0a24cd26decddd1074d13e4a6a2dc6be0d6245873ee906f385f174dc3c5cf0",
  ],
  [
    "assets/dev/blueprint-web-favicon.ico",
    "d74ee51f9d0ef8ea8ad07792ed431b16494ef8a7ec57a3d489b4212c9f929e69",
  ],
  [
    "assets/dev/blueprint-windows.ico",
    "7254a77c100c679cde6cc5cd44c235d0fa7f261ed873bd6280dc35f55571cc7f",
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
