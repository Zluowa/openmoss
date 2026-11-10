// FILE: oiuStandard.test.ts
// Purpose: Contract for the standard-catalog additions: every component its prompt groups
//          name is registered and legal inside Card, the re-scoped FormControl takes the new
//          inputs, programs that use them validate, and the URL helpers behave.

import { describe, expect, it } from "vitest";

import { mossOpenUILibrary } from "../mossOpenUILibrary";
import { validateOpenUIProgram } from "../openUIValidation";
import {
  DateTimeInput,
  SegmentedControl,
  standardComponentGroups,
  standardComponents,
} from "./oiuStandard";
import { canPlayInline, hostOf, publisherOf, youTubeId } from "./oiuStandardViews";

describe("standard catalog", () => {
  it("registers every component its prompt groups name, and nothing unlisted", () => {
    const grouped = standardComponentGroups.flatMap((group) => group.components);
    expect(new Set(grouped)).toEqual(new Set(standardComponents.map((c) => c.name)));
    for (const name of grouped) expect(mossOpenUILibrary.components[name], name).toBeDefined();
  });

  it("keeps its notes whole in the core catalog, which cuts lines at a spaced em dash", () => {
    for (const note of standardComponentGroups.flatMap((group) => group.notes ?? [])) {
      expect(note).not.toMatch(/\s—/);
    }
  });

  it("lets a FormControl hold DateTimeInput and SegmentedControl", () => {
    const options = mossOpenUILibrary.components.FormControl?.props.shape.input.options ?? [];
    expect(options).toContain(DateTimeInput.ref);
    expect(options).toContain(SegmentedControl.ref);
    expect(mossOpenUILibrary.components.Form?.props.shape.fields.unwrap().element).toBe(
      mossOpenUILibrary.components.FormControl?.ref,
    );
  });

  it("validates a program built from the new components", () => {
    const program = [
      "root = Card([grid, cited, defined, form])",
      'grid = Grid([EntityCard("Sony WH-1000XM5", "Headphones", null, null, "$399", {label: "Top pick", tone: "success"}, 4.7, 12480, "https://www.sony.com"), LinkCard("https://react.dev/reference/react/hooks", "Built-in React Hooks")], 2)',
      'cited = CitedText("Weight loss was similar [1].", [{title: "NEJM 2022", url: "https://www.nejm.org/doi/full/10.1056/NEJMoa2114833"}])',
      'defined = DefinedText("EBITDA rose.", [{term: "EBITDA", definition: "Earnings before interest, taxes, depreciation and amortization."}])',
      'form = Form("booking", Buttons([Button("Book")]), [FormControl("Start", DateTimeInput("start", "datetime", 15)), FormControl("Length", SegmentedControl("length", ["30 min", "1 h"]))])',
    ].join("\n");
    expect(validateOpenUIProgram(program).unknownComponents).toEqual([]);
  });
});

describe("standard catalog URL helpers", () => {
  it("reads YouTube ids from watch, short, embed and youtu.be URLs only", () => {
    expect(youTubeId("https://www.youtube.com/watch?v=TNhaISOUy6Q")).toBe("TNhaISOUy6Q");
    expect(youTubeId("https://youtu.be/TNhaISOUy6Q?t=30")).toBe("TNhaISOUy6Q");
    expect(youTubeId("https://www.youtube.com/shorts/abcdef12345")).toBe("abcdef12345");
    expect(youTubeId("https://www.youtube-nocookie.com/embed/abcdef12345")).toBe("abcdef12345");
    expect(youTubeId("https://example.com/watch?v=TNhaISOUy6Q")).toBeNull();
    expect(youTubeId("javascript:alert(1)")).toBeNull();
  });

  it("names a site by its host without www, and only for http(s) URLs", () => {
    expect(hostOf("https://www.nejm.org/doi/full/x")).toBe("nejm.org");
    expect(hostOf("http://react.dev")).toBe("react.dev");
    expect(hostOf("ftp://example.com")).toBe("");
    expect(hostOf(undefined)).toBe("");
  });

  it("labels a citation chip with its publisher, then the site, then the number", () => {
    expect(publisherOf({ source: "Reuters", url: "https://www.reuters.com/x" }, 1)).toBe("Reuters");
    expect(publisherOf({ url: "https://www.rtings.com/headphones" }, 2)).toBe("rtings");
    expect(publisherOf({ url: "https://news.bbc.co.uk/a" }, 3)).toBe("news.bbc.co");
    expect(publisherOf({ title: "No link" }, 4)).toBe("4");
  });

  it("plays only media the app's policy admits inline (loopback hosts)", () => {
    expect(canPlayInline("http://127.0.0.1:5733/clip.mp4")).toBe(true);
    expect(canPlayInline("http://localhost/clip.mp3")).toBe(true);
    expect(canPlayInline("https://interactive-examples.mdn.mozilla.net/media/clip.mp4")).toBe(
      false,
    );
    expect(canPlayInline("not a url")).toBe(false);
  });
});
