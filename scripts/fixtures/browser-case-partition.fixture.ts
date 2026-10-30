import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

declare const MOSS_PARTITION_FIXTURE_FAIL_AFTER_ALL: boolean;

let fixtureInitializations = 0;
let testBodies = 0;
let fixtureCleanups = 0;
const initializedFixtures = new WeakSet<object>();

describe("full-app fixture", () => {
  beforeEach((context) => {
    initializedFixtures.add(context.task);
    fixtureInitializations += 1;
  });
  afterEach((context) => {
    if (!initializedFixtures.delete(context.task)) return;
    fixtureCleanups += 1;
  });
  afterAll(() => {
    // A skipped partition must not initialize the expensive app fixture.
    expect(fixtureInitializations).toBe(testBodies);
    expect(fixtureCleanups).toBe(testBodies);
    if (MOSS_PARTITION_FIXTURE_FAIL_AFTER_ALL) throw new Error("intentional suite-hook failure");
  });
  it.each(Array.from({ length: 64 }, (_, index) => index))("workflow %i", () => {
    testBodies += 1;
  });
  describe("nested suite", () => {
    it.each(["desktop", "tablet", "mobile", "narrow"])("restores streaming follow at %s", () => {
      testBodies += 1;
    });
    it("新增用例 is included automatically", () => {
      testBodies += 1;
    });
    it("duplicate title", () => {
      testBodies += 1;
    });
    it("duplicate title", () => {
      testBodies += 1;
    });
  });
  it.skip("an existing explicit skip stays skipped", () => {
    throw new Error("must not run");
  });
  it("[geometry:linux] an existing quarantine stays separate", () => {
    throw new Error("must not run");
  });
});
