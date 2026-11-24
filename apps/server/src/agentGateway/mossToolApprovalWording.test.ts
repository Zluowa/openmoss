// WALK-7 N7-2 / REVIEW-RULES rule 9: an approval card for one of Moss's own tools says what the
// tool will do, in the person's language, or falls back to the tool's name. A tool that deletes,
// publishes or cancels must say what it does: a person must be able to tell it from a read.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { mossToolApprovalAction } from "@moss/shared/mossToolPresentation";
import { describe, expect, it } from "vitest";

const gatewayDir = import.meta.dirname;

/** Every Moss tool name this gateway registers (`name: "moss_…"` in its tool definitions). */
function registeredMossToolNames(): string[] {
  const names = new Set<string>();
  for (const file of readdirSync(gatewayDir)) {
    if (!file.endsWith(".ts") || file.endsWith(".test.ts")) continue;
    const source = readFileSync(path.join(gatewayDir, file), "utf8");
    for (const match of source.matchAll(/\bname:\s*"(moss_[a-z0-9_]+)"/gu)) names.add(match[1]!);
  }
  return [...names].toSorted();
}

/** Tools whose effect cannot be undone from the chat, or reaches other people. */
const DESTRUCTIVE_OR_PUBLISHING =
  /(?:^|_)(?:delete|forget|publish|cancel|remove|archived?)(?:_|$)/u;

describe("approval wording for Moss's own tools", () => {
  const names = registeredMossToolNames();

  it("finds the gateway's tools", () => {
    expect(names.length).toBeGreaterThan(50);
    expect(names).toContain("moss_canvas_open");
  });

  it("gives every tool that deletes, publishes or cancels a sentence in both languages", () => {
    const missing = names
      .filter((name) => DESTRUCTIVE_OR_PUBLISHING.test(name))
      .filter(
        (name) =>
          mossToolApprovalAction(name, "zh-CN") === null ||
          mossToolApprovalAction(name, "en") === null,
      );
    expect(missing).toEqual([]);
  });
});
