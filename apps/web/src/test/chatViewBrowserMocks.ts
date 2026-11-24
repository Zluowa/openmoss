// FILE: chatViewBrowserMocks.ts
// Purpose: State shared by the module mocks every ChatView browser file declares, and by the
//          tests that switch them (the desktop title bar) or read them (the voice transports).

import { vi } from "vitest";

export const desktopTitleBar = { on: false };

export const realtimeVoiceChatHarness = {
  webRtcConstructed: vi.fn(),
  webRtcDisposed: vi.fn(),
  webSocketConstructed: vi.fn(),
  webSocketDisposed: vi.fn(),
};
