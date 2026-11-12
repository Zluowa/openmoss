import { describe, expect, it } from "vitest";

import {
  MCP_APP_JSON_HEALER_SOURCE,
  MCP_APP_PRINT_RECEIVER_HTML,
  MCP_APP_PRINT_RECEIVER_SOURCE,
  MCP_APP_WHEEL_COALESCER_SOURCE,
  MCP_APP_WHEEL_RELAY_SOURCE,
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
    expect(MCP_APP_PRINT_RECEIVER_HTML.match(/<script>/gu)).toHaveLength(2);
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

interface FakeElement {
  nodeType: 1;
  parentElement: FakeElement | null;
  overflowY: string;
  overflowX: string;
  scrollTop: number;
  scrollLeft: number;
  scrollHeight: number;
  clientHeight: number;
  scrollWidth: number;
  clientWidth: number;
}

function fakeElement(
  parent: FakeElement | null,
  overrides: Partial<FakeElement> = {},
): FakeElement {
  return {
    nodeType: 1,
    parentElement: parent,
    overflowY: "visible",
    overflowX: "visible",
    scrollTop: 0,
    scrollLeft: 0,
    scrollHeight: 100,
    clientHeight: 100,
    scrollWidth: 100,
    clientWidth: 100,
    ...overrides,
  };
}

/** Runs the relay against a fake widget page; returns a wheel dispatcher and what it posted. */
function loadWheelRelay(root: FakeElement) {
  const posted: unknown[] = [];
  const frames: Array<() => void> = [];
  let wheel: ((event: Record<string, unknown>) => void) | null = null;
  let options: unknown = null;
  const parent = { postMessage: (data: unknown) => posted.push(data) };
  const fakeWindow = {
    parent,
    innerWidth: 400,
    innerHeight: 300,
    getComputedStyle: (element: FakeElement) => ({
      overflowY: element.overflowY,
      overflowX: element.overflowX,
    }),
    addEventListener: (type: string, listener: typeof wheel, listenerOptions: unknown) => {
      if (type === "wheel") {
        wheel = listener;
        options = listenerOptions;
      }
    },
  };
  // The relay's "next task" is a MessageChannel message; this one queues it for frame().
  class FakeMessageChannel {
    readonly port1: { onmessage: (() => void) | null } = { onmessage: null };
    readonly port2 = { postMessage: () => frames.push(() => this.port1.onmessage?.()) };
  }
  new Function("window", "document", "MessageChannel", MCP_APP_WHEEL_RELAY_SOURCE)(
    fakeWindow,
    { scrollingElement: root, documentElement: root },
    FakeMessageChannel,
  );
  const dispatch = (event: Record<string, unknown>) => {
    const full = {
      deltaMode: 0,
      deltaX: 0,
      deltaY: 0,
      ctrlKey: false,
      defaultPrevented: false,
      ...event,
    };
    wheel?.(full);
    return full;
  };
  const frame = () => {
    for (const callback of frames.splice(0)) callback();
  };
  return { dispatch, frame, posted, options: () => options };
}

describe("MCP App wheel relay", () => {
  it("is plain JS, passive, and posts only the Moss wheel type", () => {
    expect(() => new Function(MCP_APP_WHEEL_RELAY_SOURCE)).not.toThrow();
    expect(MCP_APP_WHEEL_RELAY_SOURCE).toContain('"moss:wheel"');
    expect(MCP_APP_WHEEL_RELAY_SOURCE).not.toMatch(/<\/script/iu);
    expect(MCP_APP_PRINT_RECEIVER_HTML).toContain(MCP_APP_WHEEL_RELAY_SOURCE);
    const relay = loadWheelRelay(fakeElement(null));
    expect(relay.options()).toEqual({ passive: true });
  });

  it("reports wheel a page that cannot scroll leaves, once per frame", () => {
    const root = fakeElement(null);
    const target = fakeElement(root);
    const relay = loadWheelRelay(root);
    relay.dispatch({ target, deltaY: 40 });
    relay.dispatch({ target, deltaY: 60, deltaX: 5 });
    expect(relay.posted).toEqual([]);
    relay.frame();
    expect(relay.posted).toEqual([{ type: "moss:wheel", deltaX: 5, deltaY: 100 }]);
  });

  it("keeps wheel an inner scroller or the page still uses, and passes it on at the edge", () => {
    const root = fakeElement(null, { scrollHeight: 500, clientHeight: 200, scrollTop: 0 });
    const list = fakeElement(root, { overflowY: "auto", scrollHeight: 300, clientHeight: 100 });
    const item = fakeElement(list);
    const relay = loadWheelRelay(root);
    relay.dispatch({ target: item, deltaY: 30 });
    relay.frame();
    expect(relay.posted).toEqual([]);
    // The list is at its bottom but the page can still go down.
    list.scrollTop = 200;
    relay.dispatch({ target: item, deltaY: 30 });
    relay.frame();
    expect(relay.posted).toEqual([]);
    // Both at the bottom: the rest carries on to the transcript.
    root.scrollTop = 300;
    relay.dispatch({ target: item, deltaY: 30 });
    relay.frame();
    expect(relay.posted).toEqual([{ type: "moss:wheel", deltaX: 0, deltaY: 30 }]);
    // Going up is still the list's.
    relay.dispatch({ target: item, deltaY: -30 });
    relay.frame();
    expect(relay.posted).toHaveLength(1);
  });

  it("skips cancelled and pinch-zoom wheel and turns lines and pages into pixels", () => {
    const root = fakeElement(null);
    const relay = loadWheelRelay(root);
    const cancelled = relay.dispatch({ target: root, deltaY: 50 });
    cancelled.defaultPrevented = true;
    relay.dispatch({ target: root, deltaY: 50, ctrlKey: true });
    relay.frame();
    expect(relay.posted).toEqual([]);
    relay.dispatch({ target: root, deltaY: 3, deltaMode: 1 });
    relay.frame();
    relay.dispatch({ target: root, deltaY: 1, deltaMode: 2 });
    relay.frame();
    relay.dispatch({ target: root, deltaY: Number.NaN });
    relay.frame();
    expect(relay.posted).toEqual([
      { type: "moss:wheel", deltaX: 0, deltaY: 48 },
      { type: "moss:wheel", deltaX: 0, deltaY: 300 },
    ]);
  });
});

describe("MCP App proxy wheel coalescer", () => {
  it("adds wheel up per task, never loses any, and drops anything that is not numbers", () => {
    const frames: Array<() => void> = [];
    const posts: Array<[number, number]> = [];
    const push = new Function(
      `${MCP_APP_WHEEL_COALESCER_SOURCE}; return createMossWheelCoalescer;`,
    )()(
      (x: number, y: number) => posts.push([x, y]),
      (task: () => void) => frames.push(task),
    ) as (data: unknown) => boolean;

    expect(push({ jsonrpc: "2.0", method: "ui/notifications/size-changed" })).toBe(false);
    expect(push(null)).toBe(false);
    expect(push({ type: "moss:wheel", deltaX: 0, deltaY: 120 })).toBe(true);
    expect(push({ type: "moss:wheel", deltaX: 2, deltaY: 30 })).toBe(true);
    expect(push({ type: "moss:wheel", deltaX: "1", deltaY: 30 })).toBe(true);
    expect(push({ type: "moss:wheel", deltaX: 0, deltaY: Number.POSITIVE_INFINITY })).toBe(true);
    expect(push({ type: "moss:wheel", deltaX: 0, deltaY: 30, extra: 1 })).toBe(true);
    expect(frames).toHaveLength(1);
    frames.splice(0)[0]!();
    expect(posts).toEqual([[2, 150]]);
    // One message is capped at 1000 px; a sum above that goes out in pieces, none lost.
    push({ type: "moss:wheel", deltaX: 0, deltaY: 1e9 });
    push({ type: "moss:wheel", deltaX: 0, deltaY: 900 });
    push({ type: "moss:wheel", deltaX: -300, deltaY: 0 });
    while (frames.length > 0) frames.shift()!();
    expect(posts.slice(1)).toEqual([
      [-300, 1000],
      [0, 900],
    ]);
    // N px in, N px out, exactly once.
    posts.length = 0;
    for (let tick = 0; tick < 3; tick += 1) push({ type: "moss:wheel", deltaX: 0, deltaY: 300 });
    while (frames.length > 0) frames.shift()!();
    expect(posts.reduce((sum, [, y]) => sum + y, 0)).toBe(900);
    expect(posts).toHaveLength(1);
  });
});
