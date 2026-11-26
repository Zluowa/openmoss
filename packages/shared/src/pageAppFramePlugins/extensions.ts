// FILE: extensions.ts
// Purpose: Frame halves of the 应用页 capabilities that reach past the page
// (mcp, files, assets, room, comments), listed once for the runtime registry.
// Layer: Shared frame plugins

import type { PageAppFramePlugin } from "../pageAppCapabilityPlugin";
import { assetsFramePlugin } from "./assets";
import { chatFramePlugin } from "./chat";
import { commentsFramePlugin } from "./comments";
import { filesFramePlugin } from "./files";
import { mcpFramePlugin } from "./mcp";
import { mediaFramePlugin } from "./media";
import { mossbotFramePlugin } from "./mossbot";
import { roomFramePlugin } from "./room";
import { voiceFramePlugin } from "./voice";

export const PAGE_APP_EXTENSION_FRAME_PLUGINS: readonly PageAppFramePlugin[] = [
  mcpFramePlugin,
  filesFramePlugin,
  assetsFramePlugin,
  roomFramePlugin,
  commentsFramePlugin,
  mediaFramePlugin,
  chatFramePlugin,
  mossbotFramePlugin,
  voiceFramePlugin,
];
