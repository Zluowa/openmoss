// FILE: bundled-moss-canvas.ts
// Purpose: Stages and validates the complete Open Moss Canvas workspace bundled into the desktop artifact.
// Layer: Release/build helper

import * as Crypto from "node:crypto";
import * as FS from "node:fs";
import * as Path from "node:path";
import { compareUtf8Bytes } from "./utf8-byte-order.ts";

export const MOSS_CANVAS_BUNDLE_DIR = "apps/desktop/canvas-bundle";
export const MOSS_CANVAS_EXTRA_RESOURCE = {
  from: MOSS_CANVAS_BUNDLE_DIR,
  to: "moss-canvas",
} as const;

// The hosted runtime resolves these relative to the bundled appRoot; dropping
// one would only surface at runtime inside an otherwise healthy installer.
export const MOSS_CANVAS_BUNDLE_REQUIRED_PATHS = [
  "LICENSE",
  "NOTICE",
  "apps/codex-canvas/src/HoolaMorphingTabs.LICENSE",
  "apps/codex-canvas/package.json",
  "apps/codex-canvas/dist/index.html",
  "apps/codex-canvas/electron/desktop-runtime.mjs",
  "apps/codex-canvas/electron/preload.cjs",
  "apps/codex-canvas/server/hosted-storage.mjs",
  "electron/runtime.mjs",
  "electron/native-renderer-api.mjs",
] as const;
const PAGE_EDITOR_RUNTIME_PATH = "apps/codex-canvas/dist/page-editor.html";

// Self-contained subset of the canvas checkout. The renderer dist is fully
// bundled by Vite; the Electron main modules import only host-provided
// `electron`, node builtins, and an optionally-absent @sentry/electron.
const BUNDLE_COPY_PATHS = [
  "LICENSE",
  "NOTICE",
  "COMMERCIAL_LICENSE.md",
  "apps/codex-canvas/src/HoolaMorphingTabs.LICENSE",
  "apps/codex-canvas/dist",
  "apps/codex-canvas/electron",
  "apps/codex-canvas/server",
  "apps/codex-canvas/package.json",
  "electron",
] as const;

const EXCLUDED_BASENAMES = new Set(["node_modules", "release", "dist-electron"]);
export const MOSS_CANVAS_BUNDLE_RECEIPT = "canvas-bundle-receipt.json";
export const MOSS_CANVAS_BUNDLE_HASH_ALGORITHM = "sha256-tree-utf8-v1";

// The receipt records the hash of every other file, so it can never cover itself.
const EXCLUDED_FILE = /(?:\.test\.(?:mjs|cjs|ts)|\.log)$/u;

export interface MossCanvasBundleValidation {
  readonly directory: string;
  readonly fileCount: number;
  readonly sha256: string;
}

function assertNeverCopied(relativePath: string): void {
  const base = Path.basename(relativePath);
  if (EXCLUDED_BASENAMES.has(base) || base === ".env" || base.startsWith(".env."))
    throw new Error(`Refusing to bundle ${relativePath}`);
}

function collectBundleFiles(
  directory: string,
  prefix = "",
  compareNames: (left: string, right: string) => number = compareUtf8Bytes,
): string[] {
  const entries = FS.readdirSync(directory, { withFileTypes: true }).toSorted((a, b) =>
    compareNames(a.name, b.name),
  );
  const files: string[] = [];
  for (const entry of entries) {
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink())
      throw new Error(`Moss Canvas bundle contains a symbolic link: ${relativePath}`);
    if (entry.isDirectory()) {
      if (!EXCLUDED_BASENAMES.has(entry.name))
        files.push(
          ...collectBundleFiles(Path.join(directory, entry.name), relativePath, compareNames),
        );
      continue;
    }
    if (EXCLUDED_FILE.test(entry.name) || entry.name === MOSS_CANVAS_BUNDLE_RECEIPT) continue;
    assertNeverCopied(relativePath);
    files.push(relativePath);
  }
  return files;
}

export function validateMossCanvasBundle(directory: string): MossCanvasBundleValidation {
  for (const required of MOSS_CANVAS_BUNDLE_REQUIRED_PATHS) {
    const absolute = Path.join(directory, required);
    if (!FS.existsSync(absolute) || FS.statSync(absolute).size === 0)
      throw new Error(`Moss Canvas bundle is missing ${required}`);
  }
  const summarize = (files: readonly string[]): MossCanvasBundleValidation => {
    const hash = Crypto.createHash("sha256");
    for (const file of files) {
      hash.update(file);
      hash.update("\0");
      hash.update(FS.readFileSync(Path.join(directory, file)));
      hash.update("\0");
    }
    return { directory, fileCount: files.length, sha256: hash.digest("hex") };
  };
  const receiptPath = Path.join(directory, MOSS_CANVAS_BUNDLE_RECEIPT);
  if (FS.existsSync(receiptPath)) {
    const receipt = JSON.parse(FS.readFileSync(receiptPath, "utf8")) as {
      hashAlgorithm?: unknown;
      sha256?: unknown;
      fileCount?: unknown;
      requiredPaths?: unknown;
    };
    if (
      Array.isArray(receipt.requiredPaths) &&
      receipt.requiredPaths.includes(PAGE_EDITOR_RUNTIME_PATH)
    ) {
      const pageEditor = Path.join(directory, PAGE_EDITOR_RUNTIME_PATH);
      if (
        !FS.existsSync(pageEditor) ||
        !FS.statSync(pageEditor).isFile() ||
        FS.statSync(pageEditor).size === 0
      )
        throw new Error(`Moss Canvas bundle is missing ${PAGE_EDITOR_RUNTIME_PATH}`);
    }
    if (receipt.hashAlgorithm === undefined) {
      // Unversioned receipts used a depth-first locale-sorted traversal. Keep
      // the observed Chinese/English formats and the host's original format;
      // accept a legacy order only when its complete byte digest/count match.
      // Receipt and payload bytes are never rewritten during validation.
      const locales = new Set(["zh-CN", "en-US", new Intl.Collator().resolvedOptions().locale]);
      for (const locale of locales) {
        const legacy = summarize(
          collectBundleFiles(directory, "", new Intl.Collator(locale).compare),
        );
        if (legacy.sha256 === receipt.sha256 && legacy.fileCount === receipt.fileCount)
          return legacy;
      }
      throw new Error("Moss Canvas bundle does not match its build receipt");
    }
    if (receipt.hashAlgorithm !== MOSS_CANVAS_BUNDLE_HASH_ALGORITHM) {
      throw new Error("Moss Canvas bundle has an unsupported hash algorithm");
    }
  }
  // The versioned format orders complete relative paths by UTF-8 bytes. No
  // platform locale or ICU collation participates in a newly written receipt.
  return summarize(collectBundleFiles(directory).toSorted(compareUtf8Bytes));
}

export function prepareMossCanvasBundle(input: {
  readonly sourceDir: string;
  readonly targetDir: string;
  readonly sourcePin?: {
    readonly repository: string;
    readonly commit: string;
    readonly tree: string;
    readonly lockfileSha256: string;
  };
}): MossCanvasBundleValidation {
  const source = Path.resolve(input.sourceDir);
  const target = Path.resolve(input.targetDir);
  const declaresPageEditor = FS.existsSync(Path.join(source, "apps/codex-canvas/page-editor.html"));
  if (declaresPageEditor) {
    const pageEditor = Path.join(source, PAGE_EDITOR_RUNTIME_PATH);
    if (
      !FS.existsSync(pageEditor) ||
      !FS.statSync(pageEditor).isFile() ||
      FS.statSync(pageEditor).size === 0
    )
      throw new Error(`Moss Canvas source is missing ${PAGE_EDITOR_RUNTIME_PATH}`);
  }
  const inside = (parent: string, child: string) => {
    const relative = Path.relative(parent, child);
    return (
      relative === "" ||
      (!relative.startsWith(`..${Path.sep}`) && relative !== ".." && !Path.isAbsolute(relative))
    );
  };
  if (inside(source, target))
    throw new Error("Moss Canvas bundle target must not live inside its source checkout");
  if (inside(target, source))
    throw new Error("Moss Canvas bundle target must not contain its source checkout");
  if (target === Path.parse(target).root)
    throw new Error("Moss Canvas bundle target must be a named directory");
  // Never replace an unrelated directory or follow a junction into another
  // workspace. Only an empty target or our previous receipt marks ownership.
  for (
    let directory = target;
    directory !== Path.parse(directory).root;
    directory = Path.dirname(directory)
  ) {
    if (FS.existsSync(directory) && FS.lstatSync(directory).isSymbolicLink())
      throw new Error("Moss Canvas bundle target must not use symbolic links");
  }
  if (
    FS.existsSync(target) &&
    (!FS.statSync(target).isDirectory() ||
      (FS.readdirSync(target).length > 0 &&
        !FS.existsSync(Path.join(target, MOSS_CANVAS_BUNDLE_RECEIPT))))
  )
    throw new Error("Moss Canvas bundle target is not an owned bundle directory");
  for (const copyPath of BUNDLE_COPY_PATHS) {
    const from = Path.join(source, copyPath);
    if (!FS.existsSync(from)) throw new Error(`Moss Canvas source is missing ${copyPath}`);
    if (FS.lstatSync(from).isSymbolicLink())
      throw new Error(`Refusing to bundle symbolic link ${copyPath}`);
  }
  FS.mkdirSync(Path.dirname(target), { recursive: true });
  const staging = FS.mkdtempSync(Path.join(Path.dirname(target), ".moss-canvas-stage-"));
  let backup: string | null = null;
  try {
    for (const copyPath of BUNDLE_COPY_PATHS) {
      const from = Path.join(source, copyPath);
      const to = Path.join(staging, copyPath);
      if (FS.statSync(from).isDirectory()) {
        for (const file of collectBundleFiles(from)) {
          const destination = Path.join(to, file);
          FS.mkdirSync(Path.dirname(destination), { recursive: true });
          FS.copyFileSync(Path.join(from, file), destination);
        }
      } else {
        FS.mkdirSync(Path.dirname(to), { recursive: true });
        FS.copyFileSync(from, to);
      }
    }
    const validation = validateMossCanvasBundle(staging);
    FS.writeFileSync(
      Path.join(staging, MOSS_CANVAS_BUNDLE_RECEIPT),
      `${JSON.stringify(
        {
          preparedAt: new Date().toISOString(),
          hashAlgorithm: MOSS_CANVAS_BUNDLE_HASH_ALGORITHM,
          ...(input.sourcePin ? { sourcePin: input.sourcePin } : {}),
          requiredPaths: [
            ...MOSS_CANVAS_BUNDLE_REQUIRED_PATHS,
            ...(declaresPageEditor ? [PAGE_EDITOR_RUNTIME_PATH] : []),
          ],
          fileCount: validation.fileCount,
          sha256: validation.sha256,
        },
        null,
        2,
      )}\n`,
    );
    if (FS.existsSync(target)) {
      backup = `${staging}-previous`;
      FS.renameSync(target, backup);
    }
    try {
      FS.renameSync(staging, target);
    } catch (error) {
      if (backup) {
        FS.renameSync(backup, target);
        backup = null;
      }
      throw error;
    }
    if (backup) FS.rmSync(backup, { recursive: true, force: true });
    return { ...validation, directory: target };
  } finally {
    // This exact staging directory was created above, next to the explicitly
    // resolved target. No input-derived parent is recursively removed.
    if (FS.existsSync(staging)) FS.rmSync(staging, { recursive: true, force: true });
  }
}
