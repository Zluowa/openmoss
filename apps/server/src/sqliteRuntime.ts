// FILE: sqliteRuntime.ts
// Purpose: Load the Bun-only SQLite driver without letting bundlers resolve it.
// Layer: Persistence infrastructure

import { createRequire } from "node:module";

// "bun:sqlite" only exists inside the Bun runtime. Load it through createRequire
// with a computed specifier so Node/Electron bundles never resolve it statically.
// The referrer base is irrelevant for the bun: builtin, so avoid import.meta.url
// (which would break if this file is ever bundled down to CJS).
//
// Note: the older Function("return import()") indirection breaks under Vitest's
// vm module runner with ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING.
export const importBunSqlite = (): unknown => {
  const require = createRequire("/");
  return require("bun:" + "sqlite") as unknown;
};
