import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { createDirectoryAlias, createRejectedFileAlias } from "./filesystem-links.ts";

describe("native filesystem link fixtures", () => {
  it("preserves descendant file identity through a real directory alias", () => {
    const root = mkdtempSync(join(tmpdir(), "moss-directory-alias-"));
    try {
      const target = join(root, "target");
      const alias = join(root, "alias");
      mkdirSync(target);
      writeFileSync(join(target, "identity"), "same file\n");
      createDirectoryAlias(target, alias);

      expect(lstatSync(alias).isSymbolicLink()).toBe(true);
      expect(realpathSync(join(alias, "identity"))).toBe(realpathSync(join(target, "identity")));
      expect(statSync(join(alias, "identity"), { bigint: true }).ino).toBe(
        statSync(join(target, "identity"), { bigint: true }).ino,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps rejection entries symbolic without claiming Windows file-target identity", () => {
    const root = mkdtempSync(join(tmpdir(), "moss-rejected-alias-"));
    try {
      const target = join(root, "target");
      const alias = join(root, "alias");
      writeFileSync(target, "reject this link\n");
      createRejectedFileAlias(target, alias);

      expect(lstatSync(alias).isSymbolicLink()).toBe(true);
      if (process.platform === "win32") {
        expect(statSync(alias).isDirectory()).toBe(true);
        expect(realpathSync(alias)).not.toBe(realpathSync(target));
      } else {
        expect(realpathSync(alias)).toBe(realpathSync(target));
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
