import { describe, expect, it } from "vitest";

import {
  createNativeOutputDecoder,
  decodeNativeOutput,
  parseWindowsAnsiEncoding,
} from "./platformEncoding";

// "错误: 系统找不到指定的注册表项或值。" as reg.exe writes it on Chinese Windows (GBK).
const REG_NOT_FOUND_GBK = new Uint8Array([
  0xb4, 0xed, 0xce, 0xf3, 0x3a, 0x20, 0xcf, 0xb5, 0xcd, 0xb3, 0xd5, 0xd2, 0xb2, 0xbb, 0xb5, 0xbd,
  0xd6, 0xb8, 0xb6, 0xa8, 0xb5, 0xc4, 0xd7, 0xa2, 0xb2, 0xe1, 0xb1, 0xed, 0xcf, 0xee, 0xbb, 0xf2,
  0xd6, 0xb5, 0xa1, 0xa3, 0x0d, 0x0a,
]);
const REG_NOT_FOUND_TEXT = "错误: 系统找不到指定的注册表项或值。\r\n";

describe("native output decoding", () => {
  it("reads the ANSI code page from reg.exe output", () => {
    expect(
      parseWindowsAnsiEncoding(
        "\r\nHKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Control\\Nls\\CodePage\r\n    ACP    REG_SZ    936\r\n",
      ),
    ).toBe("gbk");
    expect(parseWindowsAnsiEncoding("    ACP    REG_SZ    1252")).toBe("windows-1252");
    expect(parseWindowsAnsiEncoding("nothing here")).toBeUndefined();
  });

  it("decodes a Windows tool's GBK message instead of producing mojibake", () => {
    expect(decodeNativeOutput(REG_NOT_FOUND_GBK, "gbk")).toBe(REG_NOT_FOUND_TEXT);
  });

  it("keeps UTF-8 lines as UTF-8 when another line in the same output is GBK", () => {
    const utf8 = new TextEncoder().encode("Moss：找不到指定的路径。\n");
    const mixed = new Uint8Array([...utf8, ...REG_NOT_FOUND_GBK]);
    expect(decodeNativeOutput(mixed, "gbk")).toBe(
      `Moss：找不到指定的路径。\n${REG_NOT_FOUND_TEXT}`,
    );
  });

  it("streams UTF-8 at once and holds a GBK line until its line break", () => {
    const decoder = createNativeOutputDecoder("gbk");
    const utf8 = new TextEncoder().encode("进度 50%");
    // A UTF-8 character split across chunks waits for its last byte only.
    expect(decoder.write(utf8.subarray(0, 4))).toBe("进");
    expect(decoder.write(utf8.subarray(4))).toBe("度 50%");
    // A GBK double-byte character split across chunks is not garbled.
    expect(decoder.write(REG_NOT_FOUND_GBK.subarray(0, 7))).toBe("");
    expect(decoder.write(REG_NOT_FOUND_GBK.subarray(7))).toBe(REG_NOT_FOUND_TEXT);
    expect(decoder.write(REG_NOT_FOUND_GBK.subarray(0, 4))).toBe("");
    expect(decoder.end()).toBe("错误");
    expect(decoder.end()).toBe("");
  });
});
