// The Vitest plugin that applies test-quarantine.json to every project it is added to: whole
// files are left out of the run, single tests are skipped by the setup file. Mode comes from
// MOSS_TEST_QUARANTINE (on, off, only); a config may pin it with test.env.MOSS_TEST_QUARANTINE.
import { readFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Plugin } from "vitest/config";

import { PROVIDE_KEY, normalisePath, parseMode, type QuarantineContext } from "./context";
import {
  QUARANTINE_FILE,
  entriesFor,
  validateQuarantine,
  type QuarantineEntry,
} from "./quarantine";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../..");
// Vitest keeps setup files as forward-slash paths; the browser imports them by that path.
const setupFile = resolve(here, "setup.ts").replace(/\\/g, "/");

export interface TestQuarantineOptions {
  /** Entry files are relative to this folder; defaults to the repository. Tests use a fixture. */
  readonly repoRoot?: string;
  /** Defaults to <repoRoot>/test-quarantine.json. */
  readonly file?: string;
  readonly platform?: string;
}

export function readQuarantine(file = resolve(repoRoot, QUARANTINE_FILE)): QuarantineEntry[] {
  const raw: unknown = JSON.parse(readFileSync(file, "utf8"));
  // Expiry is the lint check's job; a run never fails because a date passed.
  const problems = validateQuarantine(raw, {});
  if (problems.length > 0) {
    throw new Error(
      `${file} is invalid (run bun run test-quarantine:check):\n- ${problems.join("\n- ")}`,
    );
  }
  return raw as QuarantineEntry[];
}

export function testQuarantine(options: TestQuarantineOptions = {}): Plugin {
  return {
    name: "moss:test-quarantine",
    configureVitest({ project }) {
      const mode = parseMode(
        project.config.env?.MOSS_TEST_QUARANTINE ?? process.env.MOSS_TEST_QUARANTINE,
      );
      const platform = options.platform ?? process.platform;
      const lowerCasePaths = platform === "win32";
      const root = options.repoRoot ?? repoRoot;
      const list = options.file ?? resolve(root, QUARANTINE_FILE);
      const entries = mode === "off" ? [] : entriesFor(readQuarantine(list), platform);
      const absolute = (file: string) => normalisePath(resolve(root, file), lowerCasePaths);
      const context: QuarantineContext = {
        mode,
        lowerCasePaths,
        wholeFiles: entries
          .filter((entry) => entry.name === undefined)
          .map((entry) => absolute(entry.file)),
        tests: entries.flatMap((entry) =>
          entry.name === undefined
            ? []
            : [{ file: absolute(entry.file), name: entry.name, id: entry.id }],
        ),
      };
      project.provide(PROVIDE_KEY, context);
      // Assign new arrays: resolved configs can share these with Vitest's defaults or other projects.
      if (!project.config.setupFiles.includes(setupFile)) {
        project.config.setupFiles = [...project.config.setupFiles, setupFile];
      }
      if (mode !== "on") return;
      const globRoot = project.config.dir || project.config.root;
      const excluded = entries.flatMap((entry) => {
        if (entry.name !== undefined) return [];
        const path = relative(globRoot, resolve(root, entry.file));
        return path.startsWith("..") || isAbsolute(path) ? [] : [path.replace(/\\/g, "/")];
      });
      if (excluded.length > 0) {
        project.config.exclude = [...project.config.exclude, ...excluded];
        // Silent by default: `vitest list --json` and other tools parse stdout.
        if (process.env.MOSS_TEST_QUARANTINE_VERBOSE === "1") {
          process.stderr.write(
            `test-quarantine: ${excluded.length} quarantined file(s) left out on ${platform} (MOSS_TEST_QUARANTINE=off runs them)\n`,
          );
        }
      }
    },
  };
}
