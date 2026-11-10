import { describe, expect, it } from "vitest";

import { attributeMayFetch } from "./svgRemoteReferences";

describe("attributeMayFetch", () => {
  it("keeps colors and references inside the diagram", () => {
    for (const value of [
      "fill:#fff;stroke:var(--pele-line)",
      "url(#arrowhead)",
      "marker-end: url( '#m-1' )",
      'fill: url("#gradient")',
      "font: 12px/1.4 sans-serif",
    ]) {
      expect(attributeMayFetch(value), value).toBe(false);
    }
  });

  it("drops anything that could load a remote image", () => {
    for (const value of [
      "background:url(https://tracker.example/p.png)",
      "fill: URL( //tracker.example/p.svg#x)",
      "background-image: url('data:image/png;base64,AAAA')",
      String.raw`background:u\72 l(https://tracker.example)`,
      '@import "https://tracker.example/a.css"',
      'background-image: -webkit-image-set("https://tracker.example/p.png" 1x)',
      "filter: url(https://tracker.example/f.svg#blur)",
    ]) {
      expect(attributeMayFetch(value), value).toBe(true);
    }
  });
});
