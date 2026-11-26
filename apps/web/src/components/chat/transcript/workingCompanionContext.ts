// FILE: workingCompanionContext.ts
// Purpose: Tells the working line whose conversation it is in. In a Mossbot conversation it carries the assistant's
//          appearance, so an assistant that wears the pinwheel kid shows the kid acting out the live turn instead of
//          the Moss mark.
// Layer: Chat transcript context
// Exports: WorkingCompanionContext, WorkingCompanion

import { createContext } from "react";

export interface WorkingCompanion {
  readonly icon: string | null;
  readonly color: string | null;
}

/** No companion: the working line shows the Moss mark. */
export const WorkingCompanionContext = createContext<WorkingCompanion | null>(null);
