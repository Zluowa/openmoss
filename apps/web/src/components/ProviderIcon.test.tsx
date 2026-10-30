import { SUPPORTED_PROVIDER_KINDS } from "@synara/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { PROVIDER_ICON_COMPONENT_BY_PROVIDER } from "./ProviderIcon";

describe("PROVIDER_ICON_COMPONENT_BY_PROVIDER", () => {
  it("maps every supported provider to an icon component", () => {
    for (const provider of SUPPORTED_PROVIDER_KINDS) {
      expect(PROVIDER_ICON_COMPONENT_BY_PROVIDER[provider]).toBeTypeOf("function");
    }
  });

  it("renders a dedicated sanitized inline mark for the ACP agents", () => {
    const seen = new Set<string>();
    for (const provider of ["kimi", "minimax", "zcode"] as const) {
      const Icon = PROVIDER_ICON_COMPONENT_BY_PROVIDER[provider];
      const markup = renderToStaticMarkup(<Icon className="size-4" aria-hidden="true" />);
      expect(markup.startsWith("<svg")).toBe(true);
      expect(markup).toContain('class="size-4"');
      // Brand marks follow the surrounding text colour like the other CLI glyphs.
      expect(markup).toContain("currentColor");
      expect(markup).not.toMatch(/<script|<foreignObject|href=|xlink:/iu);
      expect(seen.has(markup)).toBe(false);
      seen.add(markup);
    }
  });
});
