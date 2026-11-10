// FILE: extensions.ts
// Purpose: Shell halves of the 应用页 capabilities that reach past the page
// (mcp, files, assets, room, comments), listed once for the registry.
// Layer: Web pageApps capability

import type { PageAppShellPlugin } from "@moss/shared/pageAppCapabilityPlugin";

import { assetsShellPlugin } from "./assets";
import { commentsShellPlugin } from "./comments";
import { filesShellPlugin } from "./files";
import { mcpShellPlugin } from "./mcp";
import { roomShellPlugin } from "./room";

export const EXTENSION_SHELL_PLUGINS: ReadonlyArray<PageAppShellPlugin> = [
  mcpShellPlugin,
  filesShellPlugin,
  assetsShellPlugin,
  roomShellPlugin,
  commentsShellPlugin,
];
