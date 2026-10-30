import { assert, describe, it } from "@effect/vitest";

import { threadCreationRecapSummary } from "./creationCoordinator.ts";

describe("agent gateway creation coordinator branding", () => {
  it("uses Moss in product-visible thread creation recaps", () => {
    const single = threadCreationRecapSummary(1);
    const multiple = threadCreationRecapSummary(2);

    assert.equal(single, "Created 1 Moss thread");
    assert.equal(multiple, "Created 2 Moss threads");
  });
});
