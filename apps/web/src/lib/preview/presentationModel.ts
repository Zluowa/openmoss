import {
  getSlideNotes,
  getSlideSize,
  getSlides,
  getSlideText,
  getSlideTitle,
  loadPresentation,
  type PresentationData,
  type SlideData,
} from "@office-kit/pptx";
import { renderSlideToSvg } from "@office-kit/pptx-preview";

const EMU_PER_CSS_PIXEL = 9525;

export interface PresentationSlide {
  title: string;
  notes: string;
  text: string;
}

export interface RenderedPresentationSlide {
  url: string;
  partial: boolean;
}

/** Owns generated image URLs. Nothing from an Office package is inserted in the app DOM. */
export class PresentationPreview {
  readonly slides: PresentationSlide[];
  readonly width: number;
  readonly height: number;
  private readonly rendered = new Map<number, RenderedPresentationSlide>();
  private disposed = false;

  constructor(
    private readonly presentation: PresentationData,
    private readonly sourceSlides: readonly SlideData[],
  ) {
    const size = getSlideSize(presentation);
    if (!size || size.width <= 0 || size.height <= 0) {
      throw new Error("The presentation has an invalid slide size.");
    }
    this.width = size.width / EMU_PER_CSS_PIXEL;
    this.height = size.height / EMU_PER_CSS_PIXEL;
    this.slides = sourceSlides.map((slide, index) => ({
      title: getSlideTitle(slide) || `Slide ${index + 1}`,
      notes: getSlideNotes(slide) ?? "",
      text: getSlideText(slide),
    }));
  }

  render(index: number): RenderedPresentationSlide {
    if (this.disposed) throw new Error("The presentation preview is closed.");
    const existing = this.rendered.get(index);
    if (existing) return existing;
    const slide = this.sourceSlides[index];
    if (!slide) throw new Error("This slide is unavailable.");
    const svg = renderSlideToSvg(this.presentation, slide);
    const rendered = {
      url: URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" })),
      partial: /data-pptx-fallback\s*=/.test(svg),
    };
    this.rendered.set(index, rendered);
    return rendered;
  }

  dispose() {
    this.disposed = true;
    for (const slide of this.rendered.values()) URL.revokeObjectURL(slide.url);
    this.rendered.clear();
  }
}

export async function readPresentation(bytes: ArrayBuffer): Promise<PresentationPreview> {
  const presentation = await loadPresentation(new Uint8Array(bytes));
  // The package API follows presentation.xml's relationship list, including reordered slides.
  const slides = getSlides(presentation);
  if (slides.length === 0) throw new Error("This presentation contains no slides.");
  return new PresentationPreview(presentation, slides);
}
