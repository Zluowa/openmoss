import { describe, expect, it } from "vitest";

import {
  mossEnterpriseKeyErrorMessage,
  validateMossEnterpriseKeyInput,
} from "./mossEnterpriseKey.logic";

const KEY = `moss_sk_${"a".repeat(43)}`;

describe("enterprise key input", () => {
  it("accepts a pasted key with surrounding whitespace", () => {
    expect(validateMossEnterpriseKeyInput(`  ${KEY} `)).toBeNull();
  });

  it("rejects provider keys and partial keys", () => {
    expect(validateMossEnterpriseKeyInput("")).toBe("请输入企业 API Key。");
    expect(validateMossEnterpriseKeyInput("sk-or-v1-abc")).toContain("moss_sk_");
    expect(validateMossEnterpriseKeyInput(KEY.slice(0, 20))).toContain("moss_sk_");
    expect(validateMossEnterpriseKeyInput(`${KEY}\n`)).toBe("企业 API Key 只能是一行。");
  });

  it("maps server error codes without echoing server text", () => {
    expect(mossEnterpriseKeyErrorMessage({ code: "key_rejected", message: "raw" })).toContain(
      "已被吊销",
    );
    expect(mossEnterpriseKeyErrorMessage(new Error("Failed to sign in"))).toBe(
      "暂时无法使用企业 API Key 登录，请重试。",
    );
  });
});
