// FILE: workingMarkContext.ts
// Purpose: Hands the working line's Moss mark its live signal (activity and streamed
//          progress) without passing it through the row props every transcript row shares.
//          The signal changes on every streamed character; read here, only the working line
//          re-renders for it, not the whole transcript.
// Layer: Chat transcript context
// Exports: WorkingMarkContext

import { createContext } from "react";

import type { WorkingMarkSignal } from "./workingStatus";

/** Thinking at rest outside a live timeline (for example a card drawn on its own). */
export const WorkingMarkContext = createContext<WorkingMarkSignal>({
  activity: "thinking",
  progress: 0,
});
