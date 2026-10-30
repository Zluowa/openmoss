// FILE: codexProcessEnv.overlayLinks.test.ts
// Purpose: Verifies how Codex overlays stay unified with their source home when
//          the volumes differ, symlinks are denied, or CODEX_HOME has moved.
// Layer: Server process environment tests (real filesystem).

import {
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { resolveMossCodexHomeOverlayPath } from "./codexHomePaths.ts";
import {
  buildCodexProcessEnv,
  isCodexSharedContinuationStatePrepared,
  prepareCodexHomeOverlay,
  prepareCodexHomeOverlayFromPreparedContinuationSource,
  type CodexOverlayEntryLinker,
} from "./codexProcessEnv.ts";

const SYMLINK_DENIED = Object.assign(new Error("EPERM: operation not permitted, symlink"), {
  code: "EPERM",
});
const CROSS_DEVICE = Object.assign(new Error("EXDEV: cross-device link not permitted, link"), {
  code: "EXDEV",
});

/** What a standard Windows account can do: junctions and hard links, no symlinks. */
function unprivilegedLinker(
  overrides: Partial<CodexOverlayEntryLinker> = {},
): CodexOverlayEntryLinker & { readonly copyFile: ReturnType<typeof vi.fn> } {
  return {
    symlink: (async (sourcePath: string, targetPath: string, type?: string) => {
      if (type === "junction") {
        await fs.symlink(sourcePath, targetPath, "junction");
        return;
      }
      throw SYMLINK_DENIED;
    }) as typeof fs.symlink,
    link: fs.link,
    ...overrides,
    copyFile: vi.fn(fs.copyFile),
  };
}

function expectSameFile(left: string, right: string): void {
  const leftStat = statSync(left, { bigint: true });
  const rightStat = statSync(right, { bigint: true });
  expect(leftStat.dev).toBe(rightStat.dev);
  expect(leftStat.ino).toBe(rightStat.ino);
}

function copiedEntryNames(linker: { readonly copyFile: ReturnType<typeof vi.fn> }): string[] {
  return linker.copyFile.mock.calls.map(([sourcePath]) => path.basename(String(sourcePath)));
}

function makeHome(homePath: string, contents: string): void {
  mkdirSync(path.join(homePath, "sessions"), { recursive: true });
  mkdirSync(path.join(homePath, "archived_sessions"), { recursive: true });
  writeFileSync(path.join(homePath, "sessions", "rollout.jsonl"), contents, "utf8");
  writeFileSync(path.join(homePath, "history.jsonl"), contents, "utf8");
  writeFileSync(path.join(homePath, "session_index.jsonl"), contents, "utf8");
}

function withRoot(prefix: string, run: (root: string) => Promise<void>): () => Promise<void> {
  return async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), prefix));
    try {
      await run(root);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  };
}

/** A drive letter that differs from the temp directory's; it is never touched. */
function mossHomeOnAnotherVolume(root: string): string {
  return path.parse(root).root.toUpperCase().startsWith("Z")
    ? "Y:\\moss-home-never-created"
    : "Z:\\moss-home-never-created";
}

describe.runIf(process.platform === "win32")("Codex overlay across Windows volumes", () => {
  it(
    "unifies continuation files through a root on the source home's volume",
    withRoot("moss-overlay-volumes-", async (root) => {
      const sourceHome = path.join(root, "codex", "home");
      makeHome(sourceHome, "shared\n");
      const mossHome = mossHomeOnAnotherVolume(root);
      const env = { CODEX_HOME: sourceHome, MOSS_HOME: mossHome };
      const linker = unprivilegedLinker();

      const processEnv = await buildCodexProcessEnv({ env, overlayEntryLinker: linker });

      const overlayHome = processEnv.CODEX_HOME!;
      expect(overlayHome).toBe(resolveMossCodexHomeOverlayPath(env, sourceHome));
      expect(path.parse(overlayHome).root).toBe(path.parse(sourceHome).root);
      expect(lstatSync(overlayHome).isSymbolicLink()).toBe(false);
      expect(existsSync(mossHome)).toBe(false);
      expectSameFile(
        path.join(overlayHome, "history.jsonl"),
        path.join(sourceHome, "history.jsonl"),
      );
      expectSameFile(
        path.join(overlayHome, "session_index.jsonl"),
        path.join(sourceHome, "session_index.jsonl"),
      );
      expect(realpathSync(path.join(overlayHome, "sessions"))).toBe(
        realpathSync(path.join(sourceHome, "sessions")),
      );
      expect(isCodexSharedContinuationStatePrepared({ env })).toBe(true);

      await fs.appendFile(path.join(overlayHome, "history.jsonl"), "from-overlay\n");
      expect(readFileSync(path.join(sourceHome, "history.jsonl"), "utf8")).toBe(
        "shared\nfrom-overlay\n",
      );
      expect(copiedEntryNames(linker)).not.toContain("history.jsonl");
      expect(copiedEntryNames(linker)).not.toContain("session_index.jsonl");
    }),
  );

  it(
    "keeps the overlay under a MOSS_HOME that shares the source volume",
    withRoot("moss-overlay-same-volume-", async (root) => {
      const sourceHome = path.join(root, "codex", "home");
      const mossHome = path.join(root, "moss");
      makeHome(sourceHome, "shared\n");
      const env = { CODEX_HOME: sourceHome, MOSS_HOME: mossHome };

      const processEnv = await buildCodexProcessEnv({
        env,
        overlayEntryLinker: unprivilegedLinker(),
      });

      expect(processEnv.CODEX_HOME).toBe(path.join(mossHome, "codex-home-overlay"));
      expectSameFile(
        path.join(mossHome, "codex-home-overlay", "history.jsonl"),
        path.join(sourceHome, "history.jsonl"),
      );
    }),
  );
});

describe("Codex overlay without symlink privilege", () => {
  it(
    "fails closed instead of copying continuation files when no link can be made",
    withRoot("moss-overlay-no-link-", async (root) => {
      const sourceHome = path.join(root, "codex-home");
      makeHome(sourceHome, "shared\n");
      const linker = unprivilegedLinker({
        link: (async () => {
          throw CROSS_DEVICE;
        }) as typeof fs.link,
      });

      await expect(
        prepareCodexHomeOverlay({
          env: { CODEX_HOME: sourceHome, MOSS_HOME: path.join(root, "moss") },
          overlayEntryLinker: linker,
        }),
      ).rejects.toMatchObject({ code: "EPERM" });

      expect(copiedEntryNames(linker)).toEqual([]);
      expect(existsSync(path.join(root, "moss", "codex-home-overlay", "history.jsonl"))).toBe(
        false,
      );
      expect(readFileSync(path.join(sourceHome, "history.jsonl"), "utf8")).toBe("shared\n");
    }),
  );
});

describe("Codex overlay after CODEX_HOME moves", () => {
  /** The overlay an earlier Moss run left behind while CODEX_HOME was `oldHome`. */
  function makeStaleOverlay(root: string) {
    const oldHome = path.join(root, "old-home");
    const newHome = path.join(root, "new-home");
    const overlayHome = path.join(root, "moss", "codex-home-overlay");
    makeHome(oldHome, "old\n");
    makeHome(newHome, "new\n");
    mkdirSync(overlayHome, { recursive: true });
    for (const directory of ["sessions", "archived_sessions"]) {
      symlinkSync(path.join(oldHome, directory), path.join(overlayHome, directory), "junction");
    }
    for (const file of ["history.jsonl", "session_index.jsonl"]) {
      linkSync(path.join(oldHome, file), path.join(overlayHome, file));
    }
    return {
      oldHome,
      newHome,
      overlayHome,
      env: { CODEX_HOME: newHome, MOSS_HOME: path.join(root, "moss") },
    };
  }

  it(
    "re-points stale continuation links without touching the old home",
    withRoot("moss-overlay-stale-", async (root) => {
      const { oldHome, newHome, overlayHome, env } = makeStaleOverlay(root);

      await expect(prepareCodexHomeOverlay({ env })).resolves.toBe(overlayHome);

      expectSameFile(path.join(overlayHome, "history.jsonl"), path.join(newHome, "history.jsonl"));
      expectSameFile(
        path.join(overlayHome, "session_index.jsonl"),
        path.join(newHome, "session_index.jsonl"),
      );
      expect(realpathSync(path.join(overlayHome, "sessions"))).toBe(
        realpathSync(path.join(newHome, "sessions")),
      );
      expect(isCodexSharedContinuationStatePrepared({ env })).toBe(true);
      expect(readFileSync(path.join(oldHome, "history.jsonl"), "utf8")).toBe("old\n");
      expect(readFileSync(path.join(oldHome, "sessions", "rollout.jsonl"), "utf8")).toBe("old\n");
    }),
  );

  it(
    "creates missing continuation entries in a fresh home instead of keeping the old links",
    withRoot("moss-overlay-stale-fresh-", async (root) => {
      const { oldHome, newHome, overlayHome, env } = makeStaleOverlay(root);
      rmSync(newHome, { recursive: true, force: true });

      await prepareCodexHomeOverlay({ env });

      expectSameFile(path.join(overlayHome, "history.jsonl"), path.join(newHome, "history.jsonl"));
      expect(readFileSync(path.join(newHome, "history.jsonl"), "utf8")).toBe("");
      expect(readFileSync(path.join(oldHome, "history.jsonl"), "utf8")).toBe("old\n");
    }),
  );

  it(
    "re-points other hard-linked files and drops links the new home no longer has",
    withRoot("moss-overlay-stale-other-", async (root) => {
      const { oldHome, newHome, overlayHome, env } = makeStaleOverlay(root);
      writeFileSync(path.join(oldHome, "installation_id"), "old-id", "utf8");
      writeFileSync(path.join(newHome, "installation_id"), "new-id", "utf8");
      linkSync(path.join(oldHome, "installation_id"), path.join(overlayHome, "installation_id"));
      writeFileSync(path.join(oldHome, "only-old.toml"), "old", "utf8");
      linkSync(path.join(oldHome, "only-old.toml"), path.join(overlayHome, "only-old.toml"));
      mkdirSync(path.join(oldHome, "skills"));
      writeFileSync(path.join(oldHome, "skills", "keep.md"), "keep", "utf8");
      symlinkSync(path.join(oldHome, "skills"), path.join(overlayHome, "skills"), "junction");
      mkdirSync(path.join(overlayHome, "generated_images"));
      writeFileSync(path.join(overlayHome, "generated_images", "image.png"), "image", "utf8");
      writeFileSync(path.join(overlayHome, "overlay-owned.json"), "{}", "utf8");

      await prepareCodexHomeOverlay({ env });

      expect(readFileSync(path.join(overlayHome, "installation_id"), "utf8")).toBe("new-id");
      expect(readFileSync(path.join(oldHome, "installation_id"), "utf8")).toBe("old-id");
      expect(existsSync(path.join(overlayHome, "only-old.toml"))).toBe(false);
      expect(readFileSync(path.join(oldHome, "only-old.toml"), "utf8")).toBe("old");
      expect(existsSync(path.join(overlayHome, "skills"))).toBe(false);
      expect(readFileSync(path.join(oldHome, "skills", "keep.md"), "utf8")).toBe("keep");
      // State the overlay itself owns is not a link and stays where Codex wrote it.
      expect(readFileSync(path.join(overlayHome, "generated_images", "image.png"), "utf8")).toBe(
        "image",
      );
      expect(readFileSync(path.join(overlayHome, "overlay-owned.json"), "utf8")).toBe("{}");
    }),
  );

  it(
    "still refuses to replace a continuation file that holds the only copy of its data",
    withRoot("moss-overlay-forked-", async (root) => {
      const { oldHome, newHome, overlayHome, env } = makeStaleOverlay(root);
      rmSync(path.join(overlayHome, "archived_sessions"), { recursive: true, force: true });
      rmSync(path.join(overlayHome, "sessions"), { recursive: true, force: true });
      // Deleting the old home leaves the overlay's name as the file's last one.
      rmSync(oldHome, { recursive: true, force: true });
      expect(lstatSync(path.join(overlayHome, "history.jsonl")).nlink).toBe(1);

      await expect(prepareCodexHomeOverlay({ env })).rejects.toThrow(/real entries/);

      expect(readFileSync(path.join(overlayHome, "history.jsonl"), "utf8")).toBe("old\n");
      expect(readFileSync(path.join(newHome, "history.jsonl"), "utf8")).toBe("new\n");
    }),
  );

  it(
    "refuses a continuation file that exists only in the overlay and is its last copy",
    withRoot("moss-overlay-only-copy-", async (root) => {
      const { oldHome, newHome, overlayHome, env } = makeStaleOverlay(root);
      rmSync(path.join(newHome, "history.jsonl"));
      rmSync(path.join(oldHome, "history.jsonl"));

      await expect(prepareCodexHomeOverlay({ env })).rejects.toThrow(/exists only in/);

      expect(readFileSync(path.join(overlayHome, "history.jsonl"), "utf8")).toBe("old\n");
    }),
  );

  it(
    "leaves stale links alone when a resume requires an already prepared source",
    withRoot("moss-overlay-stale-resume-", async (root) => {
      const { oldHome, overlayHome, env } = makeStaleOverlay(root);

      await expect(prepareCodexHomeOverlayFromPreparedContinuationSource({ env })).rejects.toThrow(
        /missing or damaged/,
      );

      expectSameFile(path.join(overlayHome, "history.jsonl"), path.join(oldHome, "history.jsonl"));
      expect(lstatSync(path.join(overlayHome, "sessions")).isSymbolicLink()).toBe(true);
    }),
  );
});
