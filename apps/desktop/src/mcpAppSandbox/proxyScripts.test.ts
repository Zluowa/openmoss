import { describe, expect, it } from "vitest";

import {
  MCP_APP_JSON_HEALER_SOURCE,
  MCP_APP_PRINT_RECEIVER_HTML,
  MCP_APP_PRINT_RECEIVER_SOURCE,
} from "./proxyScripts";

interface Healer {
  write(text: string): void;
  healed(): string;
  reset(): void;
  complete(): boolean;
}

const createHealer = new Function(
  `${MCP_APP_JSON_HEALER_SOURCE}; return createMossJsonHealer;`,
)() as () => Healer;

/** Healed text after each chunk. */
function healSequence(chunks: readonly string[]): string[] {
  const healer = createHealer();
  return chunks.map((chunk) => {
    healer.write(chunk);
    return healer.healed();
  });
}

/** Feed `text` one character at a time; every healed prefix must parse or be empty. */
function everyPrefixParses(text: string): void {
  const healer = createHealer();
  for (const ch of text) {
    healer.write(ch);
    const healed = healer.healed();
    if (healed === "") continue;
    expect(
      () => JSON.parse(healed),
      `${JSON.stringify(healer.healed())} after ${ch}`,
    ).not.toThrow();
  }
  expect(JSON.parse(healer.healed())).toEqual(JSON.parse(text));
}

describe("MCP App proxy JSON healer", () => {
  it("heals the streamed sequence seen from the reference proxy", () => {
    expect(healSequence(['{"ci', 'ty":"Par', 'is","days":[1', ",2", "]}"])).toEqual([
      "{}",
      '{"city":"Par"}',
      '{"city":"Paris","days":[1]}',
      '{"city":"Paris","days":[1,2]}',
      '{"city":"Paris","days":[1,2]}',
    ]);
  });

  it("drops a key that has no value yet", () => {
    expect(healSequence(['{"a"'])).toEqual(["{}"]);
    expect(healSequence(['{"a":'])).toEqual(["{}"]);
    expect(healSequence(['{"a":1,"b"'])).toEqual(['{"a":1}']);
    expect(healSequence(['{"a":1,"b":'])).toEqual(['{"a":1}']);
    expect(healSequence(['{"a":{"b"'])).toEqual(['{"a":{}}']);
    expect(healSequence(['[{"k'])).toEqual(["[{}]"]);
  });

  it("closes strings, completes literals and drops trailing commas", () => {
    expect(healSequence(['{"a":"x'])).toEqual(['{"a":"x"}']);
    expect(healSequence(['{"a":tr'])).toEqual(['{"a":true}']);
    expect(healSequence(['{"a":n'])).toEqual(['{"a":null}']);
    expect(healSequence(['{"a":f'])).toEqual(['{"a":false}']);
    expect(healSequence(["[1,"])).toEqual(["[1]"]);
    expect(healSequence(['{"a":1, '])).toEqual(['{"a":1}']);
    expect(healSequence(["{"])).toEqual(["{}"]);
    expect(healSequence(["["])).toEqual(["[]"]);
  });

  it("cuts partial numbers back to their last valid digit", () => {
    expect(healSequence(['{"a":1'])).toEqual(['{"a":1}']);
    expect(healSequence(['{"a":1.'])).toEqual(['{"a":1}']);
    expect(healSequence(['{"a":1.5e'])).toEqual(['{"a":1.5}']);
    expect(healSequence(['{"a":1.5e+'])).toEqual(['{"a":1.5}']);
    expect(healSequence(['{"a":-'])).toEqual(["{}"]);
    expect(healSequence(['{"b":2,"a":-'])).toEqual(['{"b":2}']);
    expect(healSequence(["[1,-"])).toEqual(["[1]"]);
  });

  it("cuts an escape that is still being written", () => {
    expect(healSequence(['{"a":"x\\'])).toEqual(['{"a":"x"}']);
    expect(healSequence(['{"a":"x\\u00'])).toEqual(['{"a":"x"}']);
    expect(healSequence(['{"a":"x\\u00e9'])).toEqual(['{"a":"x\\u00e9"}']);
    expect(healSequence(['{"a\\'])).toEqual(["{}"]);
  });

  it("ignores text after the top-level value until reset", () => {
    const healer = createHealer();
    healer.write('{"a":1}');
    expect(healer.complete()).toBe(true);
    healer.write(',"b":2}');
    expect(healer.healed()).toBe('{"a":1}');
    healer.reset();
    expect(healer.healed()).toBe("");
    healer.write('{"b":');
    expect(healer.healed()).toBe("{}");
    healer.write("2}trailing");
    expect(healer.healed()).toBe('{"b":2}');
  });

  it("keeps every healed prefix parseable for nested input", () => {
    everyPrefixParses(
      '{"title":"Chart \\"Q3\\" \\u00e9","rows":[{"x":-1.5e+3,"y":true},{"x":0,"y":null}],"tags":["a","b"],"n":{"deep":[[],{}]}}',
    );
    everyPrefixParses('{ "spaced" : [ 1 , 2 , { "k" : "v" } ] , "z" : false }');
  });

  it("returns an empty heal before any text", () => {
    expect(createHealer().healed()).toBe("");
  });
});

describe("MCP App print receiver", () => {
  it("is plain JS with the Moss message type and is appended as one script", () => {
    expect(() => new Function(MCP_APP_PRINT_RECEIVER_SOURCE)).not.toThrow();
    expect(MCP_APP_PRINT_RECEIVER_SOURCE).toContain('"moss:print-theme"');
    expect(MCP_APP_PRINT_RECEIVER_SOURCE).toContain("moss-print-force-light");
    expect(MCP_APP_PRINT_RECEIVER_HTML.match(/<script>/gu)).toHaveLength(1);
    expect(MCP_APP_PRINT_RECEIVER_SOURCE).not.toMatch(/<\/script/iu);
  });

  it("flips to light before printing and follows the latest theme after", () => {
    const listeners: Array<(event: { source: unknown; data: unknown }) => void> = [];
    const attributes = new Map<string, string>();
    const styleElements: Array<{ id: string; textContent: string; remove: () => void }> = [];
    const root = {
      style: { colorScheme: "dark" },
      getAttribute: (name: string) => attributes.get(name) ?? null,
      setAttribute: (name: string, value: string) => attributes.set(name, value),
      removeAttribute: (name: string) => attributes.delete(name),
      appendChild: (element: { id: string; textContent: string; remove: () => void }) =>
        styleElements.push(element),
    };
    const parent = {};
    const fakeDocument = {
      documentElement: root,
      head: null,
      createElement: () => {
        const element = {
          id: "",
          textContent: "",
          remove: () => styleElements.splice(styleElements.indexOf(element), 1),
        };
        return element;
      },
      getElementById: (id: string) => styleElements.find((element) => element.id === id) ?? null,
    };
    const fakeWindow = {
      parent,
      addEventListener: (
        _type: string,
        listener: (event: { source: unknown; data: unknown }) => void,
      ) => listeners.push(listener),
    };
    attributes.set("data-mode", "dark");
    new Function("window", "document", MCP_APP_PRINT_RECEIVER_SOURCE)(fakeWindow, fakeDocument);
    const send = (data: unknown, source: unknown = parent) => {
      for (const listener of listeners) listener({ source, data });
    };
    send({ type: "moss:print-theme", phase: "before" }, {});
    expect(root.style.colorScheme).toBe("dark");
    send({ type: "anthropic:print-theme", phase: "before" });
    expect(root.style.colorScheme).toBe("dark");
    send({ type: "moss:print-theme", phase: "before" });
    expect(root.style.colorScheme).toBe("light");
    expect(attributes.get("data-mode")).toBe("light");
    expect(styleElements.map((element) => element.id)).toEqual(["moss-print-force-light"]);
    send({ type: "moss:print-theme", phase: "before" });
    expect(styleElements).toHaveLength(1);
    send({ type: "moss:print-theme", phase: "after", theme: "light" });
    expect(root.style.colorScheme).toBe("light");
    expect(attributes.get("data-mode")).toBe("light");
    expect(styleElements).toHaveLength(0);

    attributes.set("data-mode", "custom");
    root.style.colorScheme = "dark";
    send({ type: "moss:print-theme", phase: "before" });
    expect(attributes.get("data-mode")).toBe("custom");
    send({ type: "moss:print-theme", phase: "after", theme: "light" });
    expect(root.style.colorScheme).toBe("dark");
    expect(attributes.get("data-mode")).toBe("custom");

    attributes.delete("data-mode");
    root.style.colorScheme = "";
    send({ type: "moss:print-theme", phase: "before" });
    expect(attributes.get("data-mode")).toBe("light");
    send({ type: "moss:print-theme", phase: "after", theme: "dark" });
    expect(attributes.has("data-mode")).toBe(false);
    expect(root.style.colorScheme).toBe("");
  });
});
