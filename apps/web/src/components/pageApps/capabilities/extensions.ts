// FILE: extensions.ts
// Purpose: Shell halves of the 应用页 capabilities that reach past the page
// (mcp, files, assets, room, comments), listed once for the registry.
// Layer: Web pageApps capability

import type { PageAppShellPlugin } from "@moss/shared/pageAppCapabilityPlugin";

import { assetsShellPlugin } from "./assets";
import { chatShellPlugin } from "./chat";
import { commentsShellPlugin } from "./comments";
import { filesShellPlugin } from "./files";
import { mcpShellPlugin } from "./mcp";
import { mediaShellPlugin } from "./media";
import { mossbotShellPlugin } from "./mossbot";
import { roomShellPlugin } from "./room";
import { voiceShellPlugin } from "./voice";

export const EXTENSION_SHELL_PLUGINS: ReadonlyArray<PageAppShellPlugin> = [
  mcpShellPlugin,
  filesShellPlugin,
  assetsShellPlugin,
  roomShellPlugin,
  commentsShellPlugin,
  mediaShellPlugin,
  chatShellPlugin,
  mossbotShellPlugin,
  voiceShellPlugin,
];
