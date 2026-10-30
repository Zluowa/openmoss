// FILE: openUIValidation.ts
// Purpose: Validate an openui-lang program against the chat component library the
//          renderer actually uses. The primary signal is hallucination detection:
//          component calls whose names are not in openuiChatLibrary surface as
//          unknownComponents, so a model's `openui` block can be checked against
//          the same catalog the openui_reference tool teaches.
// Layer: Chat UI support (used by tests today; safe to wire into the render path later)
// Depends on: @openuidev/react-lang parser, @openuidev/react-ui genui-lib

import { createParser } from "@openuidev/react-lang";

import { mossOpenUILibrary } from "./mossOpenUILibrary";

export interface OpenUIProgramValidation {
  /** True when the program parsed with no errors at all. */
  readonly ok: boolean;
  /** Component names the program calls that the chat library does not define. */
  readonly unknownComponents: ReadonlyArray<string>;
  /** All parser/validation error messages (unknown components included). */
  readonly errors: ReadonlyArray<string>;
}

// The parser is schema-derived and stateless across parses; build it once.
const chatParser = createParser(mossOpenUILibrary.toJSONSchema());

export function validateOpenUIProgram(code: string): OpenUIProgramValidation {
  const result = chatParser.parse(code);
  const errors = result.meta.errors;
  const unknownComponents = [
    ...new Set(
      errors
        .filter((error) => error.code === "unknown-component")
        .map((error) => error.component)
        .filter((name): name is string => typeof name === "string"),
    ),
  ].toSorted();
  return {
    ok: errors.length === 0,
    unknownComponents,
    errors: errors.map((error) => error.message),
  };
}
