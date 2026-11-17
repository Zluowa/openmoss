import "~/index.css";
import { render } from "vitest-browser-react";
import { describe, expect, it } from "vitest";
import { MOSSBOT_COMPANION_EYE, MOSSBOT_COMPANION_TONES } from "~/theme/mossbotCompanion";
import { MossbotCompanion } from "./MossbotCompanion";
import { MossbotAvatar } from "./MossbotAvatar";

const MOSS = MOSSBOT_COMPANION_TONES.moss.body;

function rgb(hex: string): string {
  const n = Number.parseInt(hex.slice(1), 16);
  return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
}

const nextFrames = (count: number) =>
  new Promise<void>((resolve) => {
    let left = count;
    const tick = () => (--left <= 0 ? resolve() : requestAnimationFrame(tick));
    requestAnimationFrame(tick);
  });

/** Paints the element's SVG to a canvas and returns the colour at a point given in 0..1 of its box. */
async function colourAt(svg: SVGSVGElement, fx: number, fy: number): Promise<string> {
  const box = svg.getBoundingClientRect();
  const copy = svg.cloneNode(true) as SVGSVGElement;
  copy.removeAttribute("style");
  copy.setAttribute("width", String(box.width));
  copy.setAttribute("height", String(box.height));
  const markup = new XMLSerializer().serializeToString(copy);
  const image = new Image();
  image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(markup)}`;
  await image.decode();
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(box.width);
  canvas.height = Math.round(box.height);
  const context = canvas.getContext("2d")!;
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  const [r, g, b] = context.getImageData(
    Math.round(fx * canvas.width),
    Math.round(fy * canvas.height),
    1,
    1,
  ).data;
  return `rgb(${r}, ${g}, ${b})`;
}

describe("MossbotCompanion", () => {
  it("draws a still moss-green ball with white eyes, without loading the animation", async () => {
    const screen = await render(
      <div style={{ width: 64, height: 64 }}>
        <MossbotCompanion label="Moss" className="size-16" />
      </div>,
    );
    const root = screen.container.querySelector<HTMLElement>("[data-mossbot-companion]")!;
    await nextFrames(3);
    expect(root.dataset.mossbotCompanion).toBe("still");
    const svg = root.querySelector("svg")!;
    const box = svg.getBoundingClientRect();
    expect(box.width).toBeCloseTo(64, 0);
    expect(box.height).toBeCloseTo(64, 0);
    // 64 px is the large framing: the ball sits a little below the middle of the box, the eyes on its upper half.
    expect(await colourAt(svg, 0.5, 0.78)).toBe(rgb(MOSS));
    expect(await colourAt(svg, 0.5 - 13.6 / 128, 0.57)).toBe(rgb(MOSSBOT_COMPANION_EYE));
    expect(root.querySelector(".mossbot-companion-stage svg")).toBeNull();
  });

  it("animates when live: the engine takes over and the drawing keeps changing", async () => {
    const screen = await render(<MossbotCompanion live label="Moss" className="size-16" />);
    const root = screen.container.querySelector<HTMLElement>("[data-mossbot-companion]")!;
    await expect.poll(() => root.dataset.mossbotCompanion, { timeout: 5000 }).toBe("engine");
    const svg = root.querySelector<SVGSVGElement>(".mossbot-companion-stage svg")!;
    expect(svg.getBoundingClientRect().width).toBeCloseTo(64, 0);
    const snapshots = new Set<string>();
    for (let i = 0; i < 8; i++) {
      snapshots.add(svg.innerHTML);
      await new Promise((resolve) => setTimeout(resolve, 120));
    }
    expect(snapshots.size).toBeGreaterThan(4);
  });

  it("shows a still non-idle pose without animating it", async () => {
    const screen = await render(<MossbotCompanion state="working" className="size-10" />);
    const root = screen.container.querySelector<HTMLElement>("[data-mossbot-companion]")!;
    await expect.poll(() => root.dataset.mossbotCompanion, { timeout: 5000 }).toBe("engine");
    const svg = root.querySelector<SVGSVGElement>(".mossbot-companion-stage svg")!;
    const first = svg.innerHTML;
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(svg.innerHTML).toBe(first);
    // Working: the sprout has become a small coral pinwheel above the head.
    const [red, green] = (await colourAt(svg, 0.5, 0.06)).match(/\d+/g)!.map(Number);
    expect(red).toBeGreaterThan(180);
    expect(green).toBeLessThan(140);
  });

  it("removes the engine drawing when it goes away", async () => {
    const screen = await render(<MossbotCompanion live className="size-10" />);
    const root = screen.container.querySelector<HTMLElement>("[data-mossbot-companion]")!;
    await expect.poll(() => root.dataset.mossbotCompanion, { timeout: 5000 }).toBe("engine");
    await screen.unmount();
    expect(document.querySelector(".mossbot-companion-stage svg")).toBeNull();
  });
});

describe("MossbotAvatar", () => {
  it("uses the companion for the default face, coloured by the assistant colour", async () => {
    const screen = await render(
      <MossbotAvatar icon="mossbot-pebble" color="blue" className="size-16" />,
    );
    const root = screen.container.querySelector<HTMLElement>("[data-mossbot-avatar]")!;
    expect(root.matches(".mossbot-companion")).toBe(true);
    const svg = root.querySelector("svg")!;
    expect(await colourAt(svg, 0.5, 0.78)).toBe(rgb(MOSSBOT_COMPANION_TONES.slate.body));
  });

  it("keeps a face an assistant already chose", async () => {
    const screen = await render(<MossbotAvatar icon="mossbot-fox" className="size-16" />);
    const root = screen.container.querySelector<HTMLElement>("[data-mossbot-avatar]")!;
    expect(root.tagName.toLowerCase()).toBe("svg");
    expect(root.matches(".mossbot-companion")).toBe(false);
  });
});
