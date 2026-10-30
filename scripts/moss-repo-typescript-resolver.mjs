// FILE: moss-repo-typescript-resolver.mjs
// Purpose: Lets the Node-only Gate 8 database subprocess load repository TypeScript that uses
// extensionless relative imports, without changing product-wide module resolution.

import { realpathSync } from "node:fs";
import { registerHooks } from "node:module";
import { resolve } from "node:path";

import { resolveRepoTypeScriptSpecifier } from "./moss-repo-typescript-resolver-core.ts";

const REPO_ROOT = realpathSync(resolve(import.meta.dirname, ".."));

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if (error?.code !== "ERR_MODULE_NOT_FOUND") throw error;
      const resolved = resolveRepoTypeScriptSpecifier({
        repoRoot: REPO_ROOT,
        parentURL: context.parentURL,
        specifier,
      });
      if (!resolved) throw error;
      return nextResolve(resolved, context);
    }
  },
});
