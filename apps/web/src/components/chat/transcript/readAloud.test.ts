import { describe, expect, it } from "vitest";

import { prepareReadAloudText } from "./readAloud";

describe("prepareReadAloudText", () => {
  it("reads markdown as plain prose", () => {
    expect(
      prepareReadAloudText(
        "## Done\n\n**Merged** [#365](https://github.com/o/r/pull/365) — see `bun run test`.\n\n```sh\nbun test\n```\n- one\n- two",
      ),
    ).toBe("Done Merged #365 — see bun run test. one two");
  });
});
