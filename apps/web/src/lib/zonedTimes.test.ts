import { describe, expect, it } from "vitest";

import {
  describeZonedTime,
  findZonedTimes,
  isForeignZonedTime,
  parseZonedTime,
  rehypeZonedTimes,
} from "./zonedTimes";

function offsetText(minutes: number): string {
  const sign = minutes < 0 ? "-" : "+";
  const abs = Math.abs(minutes);
  const hours = Math.floor(abs / 60);
  const rest = abs % 60;
  return `UTC${sign}${hours}${rest ? `:${String(rest).padStart(2, "0")}` : ""}`;
}

describe("findZonedTimes", () => {
  it("finds named zones, offsets and 12-hour times", () => {
    const found = findZonedTimes("Standup at 15:00 PST, demo 9:30am UTC+8, cutover 23:59:30 Z.");
    expect(found.map((match) => match.parsed.original)).toEqual([
      "15:00 PST",
      "9:30am UTC+8",
      "23:59:30 Z",
    ]);
    expect(found[0]?.parsed).toMatchObject({ hour: 15, minute: 0, zoneLabel: "PST" });
    expect(found[1]?.parsed).toMatchObject({ hour: 9, minute: 30, zone: { minutes: 480 } });
    expect(found[1]?.parsed.zoneLabel).toBe("UTC+8");
  });

  it("skips times without a zone, inside words, and versions", () => {
    expect(findZonedTimes("at 15:00 tomorrow")).toEqual([]);
    expect(findZonedTimes("v1:15:00 PST")).toEqual([]);
    expect(findZonedTimes("12:61 PST and 25:00 UTC")).toEqual([]);
  });

  it("marks a time after a date as dated", () => {
    const [match] = findZonedTimes("Released 2026-11-04 15:00 PST");
    expect(match?.dated).toBe(true);
    expect(findZonedTimes("Released Nov 4 15:00 PST")[0]?.dated).toBe(true);
  });

  it("reads region zones through their IANA name", () => {
    expect(parseZonedTime("9:00 ET")?.zone).toEqual({ iana: "America/New_York" });
    expect(parseZonedTime("9:00 ET and more")).toBeNull();
  });
});

describe("isForeignZonedTime", () => {
  it("is false in the reader's own offset and true elsewhere", () => {
    const now = new Date();
    const local = -now.getTimezoneOffset();
    const own = parseZonedTime(`12:00 ${offsetText(local)}`);
    const other = parseZonedTime(`12:00 ${offsetText(local === 180 ? 0 : 180)}`);
    expect(own && isForeignZonedTime(own, now)).toBe(false);
    expect(other && isForeignZonedTime(other, now)).toBe(true);
  });
});

describe("describeZonedTime", () => {
  const now = new Date(Date.UTC(2026, 10, 4, 12, 0, 0));

  it("converts to the reader's zone and notes the day shift", () => {
    const evening = parseZonedTime("20:00 PST")!;
    const tokyo = describeZonedTime(evening, { now, locale: "en", outputTimeZone: "Asia/Tokyo" });
    expect(tokyo).toMatchObject({ timeText: "1:00 PM", dayDelta: 1 });
    expect(tokyo?.zoneText).toMatch(/GMT\+9/);

    const morning = parseZonedTime("6:00 JST")!;
    const pacific = describeZonedTime(morning, {
      now,
      locale: "en",
      outputTimeZone: "America/Los_Angeles",
    });
    expect(pacific).toMatchObject({ timeText: "1:00 PM", dayDelta: -1 });
  });

  it("keeps the same day when there is no crossing", () => {
    const noon = parseZonedTime("12:00 UTC")!;
    expect(
      describeZonedTime(noon, { now, locale: "en", outputTimeZone: "Europe/Paris" }),
    ).toMatchObject({ timeText: "1:00 PM", dayDelta: 0 });
  });
});

describe("rehypeZonedTimes", () => {
  it("wraps each undated time and keeps the find wrapper offsets", () => {
    const tree = {
      type: "root",
      children: [
        {
          type: "element",
          tagName: "p",
          children: [
            {
              type: "element",
              tagName: "chat-find-text",
              properties: { dataChatFindTextStart: "10" },
              children: [{ type: "text", value: "Call at 15:00 PST today" }],
            },
          ],
        },
        {
          type: "element",
          tagName: "pre",
          children: [{ type: "text", value: "15:00 PST" }],
        },
      ],
    };
    rehypeZonedTimes()(tree);
    const paragraph = tree.children[0]!.children as Array<{ tagName?: string }>;
    expect(paragraph.map((node) => node.tagName)).toEqual([
      "chat-find-text",
      "moss-time",
      "chat-find-text",
    ]);
    const time = paragraph[1] as unknown as {
      properties: Record<string, string>;
      children: Array<{ properties: Record<string, string> }>;
    };
    expect(time.properties.dataOriginal).toBe("15:00 PST");
    expect(time.children[0]?.properties.dataChatFindTextStart).toBe("18");
    expect(tree.children[1]!.children).toEqual([{ type: "text", value: "15:00 PST" }]);
  });
});
