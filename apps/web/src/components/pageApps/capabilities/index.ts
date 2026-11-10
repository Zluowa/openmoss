// FILE: index.ts
// Purpose: Registry of the shell halves of 应用页 capabilities. Add a
// capability with one line in PAGE_APP_SHELL_PLUGINS.
// Layer: Web pageApps

import type { PageAppShellPlugin } from "@moss/shared/pageAppCapabilityPlugin";

import { aiShellPlugin } from "./ai";
import { EXTENSION_SHELL_PLUGINS } from "./extensions";
import { dbShellPlugin } from "./db";
import { downloadsShellPlugin } from "./downloads";
import { pageShellPlugin } from "./page";
import { permissionsShellPlugin } from "./permissions";
import { userShellPlugin } from "./user";

export const PAGE_APP_SHELL_PLUGINS: ReadonlyArray<PageAppShellPlugin> = [
  dbShellPlugin,
  aiShellPlugin,
  downloadsShellPlugin,
  userShellPlugin,
  permissionsShellPlugin,
  pageShellPlugin,
  ...EXTENSION_SHELL_PLUGINS,
];
