import { describe, expect, it } from "vitest";
import { utf8ByteLength } from "@moss/contracts";

import { closedShadowBackendIds, renderPageOutline, type AxNode } from "./pageOutline";

let nextId = 0;
const node = (
  role: string,
  name = "",
  children: AxNode[] = [],
  extra: Partial<AxNode> = {},
): AxNode[] => {
  const id = String(++nextId);
  const own: AxNode = {
    nodeId: id,
    role: { value: role },
    name: { value: name },
    childIds: children
      .filter((child) => !children.some((other) => other.childIds?.includes(child.nodeId)))
      .map((child) => child.nodeId),
    ...extra,
  };
  return [own, ...children];
};
/** Builds a flat CDP-style node list from nested helpers. */
const tree = (...parts: AxNode[][]): AxNode[] => {
  const root: AxNode = {
    nodeId: "root",
    role: { value: "RootWebArea" },
    name: { value: "Page" },
    childIds: parts.map((part) => part[0]!.nodeId),
  };
  return [root, ...parts.flat()];
};

describe("renderPageOutline", () => {
  it("lists controls with the role and name page.getByRole takes", () => {
    const { outline, truncated } = renderPageOutline(
      tree(
        node("heading", "Create account", [], {
          properties: [{ name: "level", value: { value: 1 } }],
        }),
        node("StaticText", "Full name"),
        node("textbox", "Full name", [], {
          properties: [{ name: "required", value: { value: true } }],
        }),
        node("checkbox", "Subscribe", [], {
          properties: [{ name: "checked", value: { value: "true" } }],
        }),
        node("button", "Create account", node("StaticText", "Create account")),
      ),
    );
    expect(truncated).toBe(false);
    expect(outline).toBe(
      [
        '- heading "Create account" [level=1]',
        '- textbox "Full name" [required]',
        '- checkbox "Subscribe" [checked]',
        '- button "Create account"',
      ].join("\n"),
    );
  });

  it("inlines select options and shows collapsed menus", () => {
    const { outline } = renderPageOutline(
      tree(
        node(
          "combobox",
          "Plan",
          node("MenuListPopup", "", [...node("option", "Basic"), ...node("option", "Team")]),
          {
            value: { value: "Basic" },
            properties: [{ name: "expanded", value: { value: false } }],
          },
        ),
      ),
    );
    expect(outline).toBe('- combobox "Plan": "Basic" options: Basic | Team [collapsed]');
  });

  it("marks closed shadow root controls with viewport coordinates", () => {
    const button = node("button", "Reveal", [], { backendDOMNodeId: 7 });
    const hidden = node("textbox", "PIN", [], { backendDOMNodeId: 8 });
    const { outline } = renderPageOutline(tree(button, hidden), {
      closed: new Set([7, 8]),
      positions: new Map([
        [7, { x: 117, y: 172 }],
        [8, null],
      ]),
    });
    expect(outline).toContain('- button "Reveal" @117,172 (closed shadow root)');
    expect(outline).toContain('- textbox "PIN" @offscreen (closed shadow root)');
  });

  it("collapses plain table rows and keeps status text", () => {
    const row = node("row", "", [...node("cell", "ORD-1"), ...node("cell", "REFUNDED")]);
    const { outline } = renderPageOutline(
      tree(node("table", "", row), node("status", "", node("StaticText", "Page 4 of 5"))),
    );
    expect(outline).toContain("- table");
    expect(outline).toContain("  - row: ORD-1 | REFUNDED");
    expect(outline).toContain("- status: Page 4 of 5");
  });

  it("points iframes at frameLocator", () => {
    const { outline } = renderPageOutline(tree(node("Iframe", "Support panel")));
    expect(outline).toBe('- iframe "Support panel" (use page.frameLocator)');
  });

  it("bounds the outline in UTF-8 bytes, not characters", () => {
    const links = Array.from({ length: 400 }, (_, index) => node("link", `商品详情第${index}号`));
    const { outline, truncated } = renderPageOutline(tree(...links), { maxBytes: 1_000 });
    expect(truncated).toBe(true);
    expect(utf8ByteLength(outline)).toBeLessThanOrEqual(1_000);
  });

  it("skips ignored nodes but keeps their children", () => {
    const { outline } = renderPageOutline(
      tree(node("generic", "", node("button", "Inner"), { ignored: true })),
    );
    expect(outline).toBe('- button "Inner"');
  });
});

describe("closedShadowBackendIds", () => {
  it("collects nodes under closed shadow roots only", () => {
    const ids = closedShadowBackendIds({
      backendNodeId: 1,
      children: [
        {
          backendNodeId: 2,
          shadowRoots: [
            { backendNodeId: 3, shadowRootType: "open", children: [{ backendNodeId: 4 }] },
          ],
        },
        {
          backendNodeId: 5,
          shadowRoots: [
            {
              backendNodeId: 6,
              shadowRootType: "closed",
              children: [{ backendNodeId: 7, children: [{ backendNodeId: 8 }] }],
            },
          ],
        },
      ],
    });
    expect([...ids].toSorted()).toEqual([6, 7, 8]);
  });
});
