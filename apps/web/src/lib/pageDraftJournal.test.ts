import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PageDraftJournal } from "./pageDraftJournal";

const base = "moss:page-draft:account:scope:page";
let values: Map<string, string>;
const draft = (content: string, revision = 1, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ revision, title: "Page title", content, ...extra });
const keys = () => [...values.keys()];

beforeEach(() => {
  values = new Map();
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-25T00:00:00Z"));
  let renderer = 0;
  vi.stubGlobal("crypto", { randomUUID: () => `renderer-${++renderer}` });
  vi.stubGlobal("localStorage", {
    get length() {
      return values.size;
    },
    key: (index: number) => keys()[index] ?? null,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("renderer-isolated Page draft journals", () => {
  it("preserves simultaneous renderer drafts in separate records", () => {
    const first = new PageDraftJournal(base);
    const second = new PageDraftJournal(base);
    first.write(draft("Window A"));
    vi.advanceTimersByTime(1);
    second.write(draft("Window B"));
    const records = new PageDraftJournal(base).records();
    expect(records.map((record) => record.content)).toEqual(["Window B", "Window A"]);
    expect(new Set(records.map((record) => record.key)).size).toBe(2);
    first.write(null);
    expect(new PageDraftJournal(base).records().map((record) => record.content)).toEqual([
      "Window B",
    ]);
  });

  it("does not let a late acknowledgement erase a newer draft at the recovered renderer key", () => {
    const writer = new PageDraftJournal(base);
    writer.write(draft("Old snapshot"));
    const oldReader = new PageDraftJournal(base);
    expect(JSON.parse(oldReader.read()!).content).toBe("Old snapshot");
    vi.advanceTimersByTime(1);
    writer.write(draft("New unsaved edits", 2));
    const newBytes = values.get(keys()[0]!);
    oldReader.write(null);
    expect(values.get(keys()[0]!)).toBe(newBytes);
    expect(new PageDraftJournal(base).records().map((record) => record.content)).toEqual([
      "New unsaved edits",
    ]);
  });

  it("retires only its own record and an unchanged exact recovered byte snapshot", () => {
    const raw =
      '{ "revision": 1, "title": "Legacy draft", "content": "Keep raw bytes", "richContent": "[]" }';
    values.set(base, raw);
    const recovered = new PageDraftJournal(base);
    expect(recovered.read()).toBe(raw);
    vi.advanceTimersByTime(1);
    recovered.write(draft("Successfully saved revision", 2));
    const other = new PageDraftJournal(base);
    vi.advanceTimersByTime(1);
    other.write(draft("Other renderer draft", 3));
    recovered.write(null);
    expect(values.has(base)).toBe(false);
    expect(new PageDraftJournal(base).records().map((record) => record.content)).toEqual([
      "Other renderer draft",
    ]);
  });

  it("preserves semantically equal recovered content when its stored bytes changed", () => {
    const raw = '{ "revision": 1, "title": "Page title", "content": "Same document" }';
    values.set(base, raw);
    const recovered = new PageDraftJournal(base);
    expect(recovered.read()).toBe(raw);
    const rewrittenBytes = draft("Same document");
    expect(rewrittenBytes).not.toBe(raw);
    values.set(base, rewrittenBytes);
    recovered.write(null);
    expect(values.get(base)).toBe(rewrittenBytes);
  });

  it("leaves unreadable or invalid revision records available for manual recovery", () => {
    const invalid = [
      "not-json",
      "{}",
      "null",
      "[]",
      JSON.stringify({ title: "No revision", content: "Unsaved bytes" }),
      draft("Zero revision", 0),
      draft("Negative revision", -1),
      draft("Fractional revision", 1.5),
    ];
    invalid.forEach((raw, index) => values.set(`${base}:draft:invalid-${index}`, raw));
    const before = new Map(values);
    const journal = new PageDraftJournal(base);
    expect(journal.records()).toEqual([]);
    expect(journal.read()).toBeNull();
    journal.write(null);
    expect(values).toEqual(before);
  });

  it("never scans or retires drafts belonging to another account, scope or page", () => {
    const foreign = new Map([
      ["moss:page-draft:other-account:scope:page", draft("Other account")],
      ["moss:page-draft:account:other-scope:page", draft("Other scope")],
      ["moss:page-draft:account:scope:other-page", draft("Other page")],
      [`${base}-similar:draft:x`, draft("Similar prefix")],
    ]);
    for (const [key, value] of foreign) values.set(key, value);
    const journal = new PageDraftJournal(base);
    expect(journal.records()).toEqual([]);
    expect(journal.read()).toBeNull();
    journal.write(draft("Own page"));
    journal.write(null);
    expect(values).toEqual(foreign);
  });

  it("retains canonical rich bytes and pending request identity when writing a new renderer record", () => {
    const richContent =
      '[{"type":"future-widget","state":{"x":17},"children":[{"text":"Do not flatten"}]}]';
    const pending = {
      op: "update",
      requestId: "same-request-on-retry",
      scopeSpaceId: null,
      pageId: "page",
      expectedRevision: 1,
      title: "Page title",
      content: "Do not flatten",
      richContent,
    };
    const journal = new PageDraftJournal(base);
    journal.write(draft("Do not flatten", 1, { richContent, pending }));
    const stored = JSON.parse(new PageDraftJournal(base).read()!);
    expect(stored.richContent).toBe(richContent);
    expect(stored.pending).toEqual(pending);
  });

  it("does not remove earlier recovery bytes when a new draft cannot be serialized or stored", () => {
    values.set(base, draft("Protected old draft"));
    const journal = new PageDraftJournal(base);
    const original = journal.read();
    expect(() => journal.write("not-json")).toThrow();
    expect(values.get(base)).toBe(original);
    vi.spyOn(localStorage, "setItem").mockImplementation(() => {
      throw new Error("Storage quota exhausted");
    });
    expect(() => journal.write(draft("New edit"))).toThrow("Storage quota");
    expect(values.get(base)).toBe(original);
  });
});
