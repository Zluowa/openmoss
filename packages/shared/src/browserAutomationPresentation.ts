import type { BrowserToolName } from "@moss/contracts";

import { BROWSER_TOOL_TITLE_TABLE } from "./mossToolPresentation";

// The table lives with the other tool words, which the phone app reads too.
export const BROWSER_TOOL_TITLES = BROWSER_TOOL_TITLE_TABLE satisfies Record<
  BrowserToolName,
  string
>;
