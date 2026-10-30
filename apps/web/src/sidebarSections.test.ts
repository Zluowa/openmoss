import { describe, expect, it } from "vitest";

import {
  normalizeSidebarSections,
  removeThreadFromSidebarSections,
  sidebarSectionThreadIds,
} from "./sidebarSections";

const NOW = "2026-08-31T00:00:00.000Z";

describe("sidebar section shell normalization", () => {
  it("deduplicates thread membership and drops malformed or unsupported entries", () => {
    const sections = normalizeSidebarSections(
      [
        {
          id: "section-a",
          name: "Section A",
          sortOrder: 1,
          isCollapsed: false,
          createdAt: NOW,
          updatedAt: NOW,
          items: [
            {
              key: "thread:thread-a",
              itemType: "thread",
              sortOrder: 4,
              createdAt: NOW,
              updatedAt: NOW,
            },
            {
              key: "project:project-a",
              itemType: "project",
              sortOrder: 0,
              createdAt: NOW,
              updatedAt: NOW,
            },
          ],
        },
        {
          id: "section-b",
          name: "Section B",
          sortOrder: 0,
          isCollapsed: true,
          createdAt: NOW,
          updatedAt: NOW,
          items: [
            {
              key: "thread:thread-a",
              itemType: "thread",
              sortOrder: 0,
              createdAt: NOW,
              updatedAt: NOW,
            },
            {
              key: "thread:thread-b",
              itemType: "thread",
              sortOrder: 1,
              createdAt: "",
              updatedAt: NOW,
            },
          ],
        },
        {
          id: "section-malformed",
          name: "Missing timestamps",
          sortOrder: 2,
          isCollapsed: false,
          items: [],
        },
      ],
      new Set(["thread-a", "thread-b"]),
    );

    expect(sections.map((section) => section.id)).toEqual(["section-b", "section-a"]);
    expect(sections[0]?.items).toEqual([]);
    expect(sections[1]?.items.map((item) => item.key)).toEqual([
      "project:project-a",
      "thread:thread-a",
    ]);
    expect([...sidebarSectionThreadIds(sections)]).toEqual(["thread-a"]);
  });

  it("removes a thread from every custom section and compacts order", () => {
    const sections = normalizeSidebarSections([
      {
        id: "section-a",
        name: "Section A",
        sortOrder: 0,
        isCollapsed: false,
        createdAt: NOW,
        updatedAt: NOW,
        items: [
          {
            key: "thread:thread-a",
            itemType: "thread",
            sortOrder: 0,
            createdAt: NOW,
            updatedAt: NOW,
          },
          {
            key: "thread:thread-b",
            itemType: "thread",
            sortOrder: 1,
            createdAt: NOW,
            updatedAt: NOW,
          },
        ],
      },
    ]);
    const next = removeThreadFromSidebarSections(sections, "thread-a");
    expect(next[0]?.items.map((item) => [item.key, item.sortOrder])).toEqual([
      ["thread:thread-b", 0],
    ]);
  });
});
