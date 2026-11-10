// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ExternalImage } from "./ExternalImage";
import { externalImageName, parseExternalImageSrc } from "./externalImageHosts";
import { maskSecretValue } from "./RedactedSecret";

afterEach(cleanup);

describe("parseExternalImageSrc", () => {
  it("takes http(s) addresses only", () => {
    expect(parseExternalImageSrc("https://example.com/a.png")?.url.host).toBe("example.com");
    expect(parseExternalImageSrc("./shot.png")).toBeNull();
    expect(parseExternalImageSrc("data:image/png;base64,AAAA")).toBeNull();
  });

  it("cleans the alt text", () => {
    expect(externalImageName("  build​   graph\n")).toBe("build graph");
  });
});

describe("ExternalImage", () => {
  it("never fetches the image and asks before opening it in the browser", () => {
    const open = vi.spyOn(window, "open").mockImplementation(() => null);
    const view = render(<ExternalImage src="https://img.example.com/a.png" alt="Build graph" />);
    expect(view.container.querySelector("img")).toBeNull();
    const box = view.getByRole("button", { name: "Show Image" });
    expect(box.className).toContain("h-32");
    expect(box.className).toContain("w-40");
    act(() => {
      fireEvent.click(box);
    });
    expect(view.getByText("Open external link")).toBeTruthy();
    expect(document.body.textContent).toContain("https://img.example.com/a.png");
    act(() => {
      fireEvent.click(view.getByRole("button", { name: "Open link" }));
    });
    expect(open).toHaveBeenCalledWith(
      "https://img.example.com/a.png",
      "_blank",
      "noopener,noreferrer",
    );
    open.mockRestore();
  });
});

describe("maskSecretValue", () => {
  it("keeps eight characters of a long value and dots the rest", () => {
    expect(maskSecretValue(`ghp_${"a".repeat(36)}`)).toBe(`ghp_aaaa${"•".repeat(32)}`);
  });

  it("dots a short value completely", () => {
    expect(maskSecretValue("sk-12345678")).toBe("•".repeat(11));
  });

  it("keeps a private key's header and footer lines", () => {
    const key = "-----BEGIN PRIVATE KEY-----\nAB CD\n-----END PRIVATE KEY-----";
    expect(maskSecretValue(key)).toBe(
      "-----BEGIN PRIVATE KEY-----\n•• ••\n-----END PRIVATE KEY-----",
    );
  });
});
