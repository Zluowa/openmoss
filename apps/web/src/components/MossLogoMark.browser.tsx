import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { MossLogoMark } from "./MossLogoMark";

/** A `prefers-reduced-motion` query the test can flip, like the system setting. */
function stubReducedMotion(initial: boolean) {
  const listeners = new Set<() => void>();
  const query = {
    matches: initial,
    media: "(prefers-reduced-motion: reduce)",
    addEventListener: (_: string, listener: () => void) => listeners.add(listener),
    removeEventListener: (_: string, listener: () => void) => listeners.delete(listener),
  };
  vi.spyOn(window, "matchMedia").mockImplementation(
    (media: string) =>
      (media.includes("prefers-reduced-motion")
        ? query
        : { matches: false, media, addEventListener() {}, removeEventListener() {} }) as never,
  );
  return {
    set(matches: boolean) {
      query.matches = matches;
      for (const listener of listeners) listener();
    },
  };
}

const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function folds(svg: SVGSVGElement) {
  const body = svg.firstElementChild as SVGGElement;
  return [1, 2, 3, 4].map((i) => (body.children[i] as SVGPathElement).style.opacity);
}

describe("MossLogoMark with reduced motion", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = "";
  });

  it("stays the still logo and runs no frame loop while text streams", async () => {
    stubReducedMotion(true);
    const frames = vi.spyOn(window, "requestAnimationFrame");
    const screen = await render(
      <MossLogoMark activity="replying" progress={0} data-testid="mark" />,
    );
    const svg = document.querySelector<SVGSVGElement>("[data-testid=mark]")!;
    for (let chars = 40; chars <= 400; chars += 40) {
      await screen.rerender(
        <MossLogoMark activity="replying" progress={chars} data-testid="mark" />,
      );
      await settle(20);
    }
    expect(frames).not.toHaveBeenCalled();
    expect(svg.style.rotate).toBe("");
    expect(svg.style.filter).toBe("");
    expect(folds(svg)).toEqual(["", "", "", ""]);
  });

  it("stops when the setting turns on and resumes when it turns off", async () => {
    const setting = stubReducedMotion(false);
    const screen = await render(
      <MossLogoMark activity="replying" progress={0} data-testid="mark" />,
    );
    const svg = document.querySelector<SVGSVGElement>("[data-testid=mark]")!;
    await screen.rerender(<MossLogoMark activity="replying" progress={600} data-testid="mark" />);
    await settle(150);
    expect(svg.style.rotate).not.toBe("");

    setting.set(true);
    expect(svg.style.rotate).toBe("");
    const frames = vi.spyOn(window, "requestAnimationFrame");
    await settle(150);
    expect(frames).not.toHaveBeenCalled();

    setting.set(false);
    await screen.rerender(<MossLogoMark activity="replying" progress={1200} data-testid="mark" />);
    await settle(150);
    expect(frames).toHaveBeenCalled();
    expect(svg.style.rotate).not.toBe("");
  });
});
