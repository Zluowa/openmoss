import { describe, it } from "vitest";

describe.skip("skipped on purpose", () => {});
describe.todo("planned");
describe("all skipped", () => {
  it.skip("still a test", () => {});
});
describe("runs", () => {
  it("passes", () => {});
});
