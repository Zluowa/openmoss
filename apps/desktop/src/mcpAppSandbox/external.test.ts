import { describe, expect, it } from "vitest";

import { normalizeMcpAppExternalUrl, sanitizeMcpAppDownloadFileName } from "./external";

describe("MCP App external links", () => {
  it("opens only http, https, mailto, tel and sms", () => {
    expect(normalizeMcpAppExternalUrl("https://example.com/a?b=1#c")).toBe(
      "https://example.com/a?b=1#c",
    );
    expect(normalizeMcpAppExternalUrl("http://example.com")).toBe("http://example.com/");
    expect(normalizeMcpAppExternalUrl("mailto:someone@example.com")).toBe(
      "mailto:someone@example.com",
    );
    expect(normalizeMcpAppExternalUrl("tel:+8610123456")).toBe("tel:+8610123456");
    expect(normalizeMcpAppExternalUrl("sms:+8610123456")).toBe("sms:+8610123456");
    for (const refused of [
      "javascript:alert(1)",
      "file:///C:/Windows/System32/calc.exe",
      "data:text/html,<script>alert(1)</script>",
      "vbscript:msgbox",
      "ms-settings:privacy",
      "moss://open",
      "moss-mcp-sandbox://assets/fonts/inter-latin.woff2",
      "ftp://example.com",
      "smb://host/share",
      "mailto:",
      " https://example.com",
      "https://example.com/\n",
      "https://",
      "",
      "x".repeat(9_000),
    ]) {
      expect(normalizeMcpAppExternalUrl(refused), refused.slice(0, 40)).toBe(null);
    }
    expect(normalizeMcpAppExternalUrl(42)).toBe(null);
    expect(normalizeMcpAppExternalUrl(null)).toBe(null);
  });
});

describe("MCP App download file names", () => {
  it("keeps a plain name", () => {
    expect(sanitizeMcpAppDownloadFileName("report.csv")).toBe("report.csv");
    expect(sanitizeMcpAppDownloadFileName("报告 2026.pdf")).toBe("报告 2026.pdf");
  });

  it("drops directories and reserved characters", () => {
    expect(sanitizeMcpAppDownloadFileName("../../evil.exe")).toBe("evil.exe");
    expect(sanitizeMcpAppDownloadFileName("C:\\Windows\\win.ini")).toBe("win.ini");
    expect(sanitizeMcpAppDownloadFileName('a<b>c:d"e|f?g*h.txt')).toBe("a_b_c_d_e_f_g_h.txt");
    expect(sanitizeMcpAppDownloadFileName("tab\there.txt")).toBe("tab_here.txt");
    expect(sanitizeMcpAppDownloadFileName("..hidden...")).toBe("hidden");
  });

  it("never returns an empty or device name", () => {
    expect(sanitizeMcpAppDownloadFileName("")).toBe("download");
    expect(sanitizeMcpAppDownloadFileName("...")).toBe("download");
    expect(sanitizeMcpAppDownloadFileName("CON")).toBe("download-CON");
    expect(sanitizeMcpAppDownloadFileName("lpt1.txt")).toBe("download-lpt1.txt");
  });

  it("bounds long names and keeps the extension", () => {
    const name = sanitizeMcpAppDownloadFileName(`${"a".repeat(500)}.json`);
    expect(name.length).toBe(200);
    expect(name.endsWith(".json")).toBe(true);
  });
});
