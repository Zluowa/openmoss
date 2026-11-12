import { homedir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { describeMossErrorCauses, MossAccountServiceError } from "./mossAccountErrors";
import { MossCloudAccountServiceError } from "./mossCloudAccountErrors";

describe("describeMossErrorCauses", () => {
  it("names every link under the outer error and keeps credentials out", () => {
    const bearer = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyLTEifQ.c2lnbmF0dXJlLXZhbHVl";
    const errno = Object.assign(
      new Error(
        `EBUSY: resource busy or locked, rename '${path.join(homedir(), "moss", "config.toml")}' ` +
          `with Bearer ${bearer} for +86 13800138000`,
      ),
      { code: "EBUSY", syscall: "rename" },
    );
    const error = new MossAccountServiceError({
      code: "persistence_failed",
      message: "无法配置 Moss 模型服务。",
      cause: new MossCloudAccountServiceError({
        code: "persistence_failed",
        message: "Failed to configure the managed Moss model provider.",
        cause: errno,
      }),
    });

    const described = describeMossErrorCauses(error);

    expect(described).toMatch(
      /^MossCloudAccountServiceError\[persistence_failed\]: Failed to configure .* <- Error\[EBUSY, rename\]: EBUSY: resource busy or locked, rename '~/,
    );
    expect(described).not.toContain(bearer);
    expect(described).not.toContain("13800138000");
    expect(described).not.toContain(homedir());
  });

  it("returns nothing when the error has no cause", () => {
    expect(
      describeMossErrorCauses(
        new MossAccountServiceError({ code: "persistence_failed", message: "x" }),
      ),
    ).toBeUndefined();
  });
});
