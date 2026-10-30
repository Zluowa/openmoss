// FILE: RealtimeVoiceViewportLayer.tsx
// Purpose: Present Realtime Voice inside its owning chat pane without blocking app navigation.
// Layer: Chat surface presentation

import type { ReactNode } from "react";

export function RealtimeVoiceViewportLayer(props: {
  readonly visible: boolean;
  readonly children: ReactNode;
}) {
  if (!props.visible) return null;
  return (
    <div
      className="absolute inset-0 z-[60] isolate overflow-hidden bg-background text-foreground"
      data-moss-realtime-voice-viewport-layer="true"
      data-testid="voice-viewport-layer"
    >
      {props.children}
    </div>
  );
}
