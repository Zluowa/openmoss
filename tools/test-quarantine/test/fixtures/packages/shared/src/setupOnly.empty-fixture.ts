import { beforeEach, describe, it } from "vitest";

describe("setup only, left by a merge", () => {
  beforeEach(() => {});
});
describe("kept", () => {
  it("runs", () => {});
  describe("nested setup only", () => {
    beforeEach(() => {});
  });
});
