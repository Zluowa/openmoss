import type { MossResourceImportApplyResult } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import {
  MossResourceImportReceiptAdapterError,
  requireDurableMossResourceImportReceipt,
} from "./mossResourceImportReceiptAdapter";

const receipt = {
  transactionId: "transaction-1",
  operationId: "transaction-1",
  planHash: "a".repeat(64),
  afterState: [
    {
      operationId: "operation-1",
      targetPath: "/workspace/.moss/skills/one/SKILL.md",
      state: "present" as const,
      afterHash: "b".repeat(64),
      durable: true as const,
    },
  ],
};

function result(
  overrides: Partial<MossResourceImportApplyResult> = {},
): MossResourceImportApplyResult {
  return {
    transactionId: "transaction-1",
    planId: "plan-1",
    status: "committed",
    operations: [
      {
        operationId: "operation-1",
        status: "created",
        targetPath: "/workspace/.moss/skills/one/SKILL.md",
      },
    ],
    issues: [],
    ...overrides,
  };
}

describe("Moss resource import receipt adapter", () => {
  it("accepts only a committed result with a durable typed receipt", () => {
    expect(requireDurableMossResourceImportReceipt(result({ receipt }))).toEqual(receipt);
  });

  it.each([result(), result({ status: "partial" }), result({ status: "blocked", receipt })])(
    "rejects non-durable or fixture-shaped results",
    (candidate) => {
      expect(() => requireDurableMossResourceImportReceipt(candidate)).toThrowError(
        MossResourceImportReceiptAdapterError,
      );
    },
  );
});
