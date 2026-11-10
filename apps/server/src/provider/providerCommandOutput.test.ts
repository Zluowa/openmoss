import { describe, expect, it } from "vitest";

import { decodeProviderCommandOutput } from "./providerCommandOutput";

describe("provider command output decoding", () => {
  it("preserves UTF-8 characters split across process chunks even on a GBK system", () => {
    const bytes = new TextEncoder().encode("Moss：找不到指定的路径。\n");
    const chunks = [...bytes].map((byte) => new Uint8Array([byte]));
    expect(decodeProviderCommandOutput(chunks, "gbk")).toBe("Moss：找不到指定的路径。\n");
  });

  it("decodes the native Chinese Windows missing-path error using its ANSI encoding", () => {
    const bytes = new Uint8Array([
      0xcf, 0xb5, 0xcd, 0xb3, 0xd5, 0xd2, 0xb2, 0xbb, 0xb5, 0xbd, 0xd6, 0xb8, 0xb6, 0xa8, 0xb5,
      0xc4, 0xc2, 0xb7, 0xbe, 0xb6, 0xa1, 0xa3,
    ]);
    expect(decodeProviderCommandOutput([bytes.subarray(0, 3), bytes.subarray(3)], "gbk")).toBe(
      "系统找不到指定的路径。",
    );
  });

  it("decodes a cmd.exe line in GBK next to a UTF-8 line from a Node CLI", () => {
    const utf8Line = new TextEncoder().encode("Claude：启动失败\r\n");
    const gbkLine = new Uint8Array([0xcf, 0xb5, 0xcd, 0xb3, 0xd5, 0xd2, 0xb2, 0xbb, 0xb5, 0xbd]);
    expect(decodeProviderCommandOutput([utf8Line, gbkLine], "gbk")).toBe(
      "Claude：启动失败\r\n系统找不到",
    );
  });

  it("keeps UTF-8 as the fallback when no supported system encoding is available", () => {
    expect(decodeProviderCommandOutput([new Uint8Array([0xff])])).toBe("�");
    expect(decodeProviderCommandOutput([])).toBe("");
  });
});
