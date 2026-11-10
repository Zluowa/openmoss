import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { PAGE_EDITOR_ICON_NAMES } from "./pageEditorIcons";

const publicIcons = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../public/central-icons-reversed",
);

describe("page editor icons", () => {
  it("names only icons the web app ships", () => {
    const missing = PAGE_EDITOR_ICON_NAMES.filter(
      (name) => !existsSync(path.join(publicIcons, `${name}.svg`)),
    );
    expect(missing).toEqual([]);
  });
});
