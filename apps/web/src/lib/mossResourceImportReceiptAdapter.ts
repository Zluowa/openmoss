import type { MossResourceImportApplyResult } from "@synara/contracts";

export class MossResourceImportReceiptAdapterError extends Error {
  readonly code: "durability-unsupported" | "transaction-invalid";

  constructor(code: MossResourceImportReceiptAdapterError["code"], message: string) {
    super(message);
    this.name = "MossResourceImportReceiptAdapterError";
    this.code = code;
  }
}

function isSha256(value: string): boolean {
  return /^[a-f0-9]{64}$/iu.test(value);
}

export function requireDurableMossResourceImportReceipt(
  result: MossResourceImportApplyResult,
): NonNullable<MossResourceImportApplyResult["receipt"]> {
  if (result.status !== "committed" || !result.receipt) {
    throw new MossResourceImportReceiptAdapterError(
      "durability-unsupported",
      "Moss import did not return a committed durable receipt.",
    );
  }
  const receipt = result.receipt;
  if (
    receipt.transactionId !== result.transactionId ||
    receipt.operationId.length === 0 ||
    !isSha256(receipt.planHash) ||
    receipt.afterState.length === 0 ||
    receipt.afterState.some(
      (state) =>
        state.durable !== true ||
        state.state !== "present" ||
        state.operationId.length === 0 ||
        state.targetPath.length === 0 ||
        !isSha256(state.afterHash),
    )
  ) {
    throw new MossResourceImportReceiptAdapterError(
      "transaction-invalid",
      "Moss import returned an unverifiable durable receipt.",
    );
  }
  return receipt;
}
