// FILE: mcpAppPlacement.ts
// Purpose: Where a tool row's widget block is drawn. Inside a folded 「已工作」 group the row
//          stays in the group but its widget is drawn after the group (Claude shows tool row →
//          widget → final text, widget visible), so rows there render no widget of their own.
// Layer: Chat transcript UI context
// Exports: McpAppRowPlacementContext

import { createContext } from "react";

/** "inline": the row draws its widget under itself. "outside": someone else draws it. */
export const McpAppRowPlacementContext = createContext<"inline" | "outside">("inline");
