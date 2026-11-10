// FILE: MermaidDiagram.tsx
// Purpose: Draw a Mermaid fenced block from an agent reply as a sanitized, theme-following SVG.
// Layer: Chat UI (lazy chunk)
// Origin: Ported from apps/web/src/components/chat/MermaidDiagram.tsx in T3 Code
//   (https://github.com/pingdotgg/t3code, MIT) at 8657eecb, including the expanded-SVG fit
//   from PR #27519. Moss changes: localized copy, Moss's own image viewer (the expanded image
//   carries an explicit size, because Moss's viewer reads the image's natural size), and no
//   find-in-thread copy hooks. See THIRD_PARTY_NOTICES.md.

import DOMPurify from "dompurify";
import type { DiagramType, MathResolver } from "pele/lazy";
import { use, useCallback, useState } from "react";

import { attributeMayFetch } from "~/lib/svgRemoteReferences";
import { useTranslation } from "~/localization";
import { Button } from "../ui/button";

type Pele = typeof import("pele/lazy");
type PeleLoad = { readonly status: "loaded"; readonly pele: Pele } | { readonly status: "failed" };

let coreLoad: Promise<PeleLoad> | null = null;
// Each diagram type is its own chunk, so a chat with one flowchart loads only
// the flowchart parser and layout.
const diagramLoads = new Map<DiagramType, Promise<PeleLoad>>();

function loadCore(): Promise<PeleLoad> {
  coreLoad ??= import("pele/lazy").then(
    (pele): PeleLoad => ({ status: "loaded", pele }),
    (): PeleLoad => ({ status: "failed" }),
  );
  return coreLoad;
}

function loadDiagramType(pele: Pele, type: DiagramType): Promise<PeleLoad> {
  let load = diagramLoads.get(type);
  if (!load) {
    load = pele.load(type).then(
      (): PeleLoad => ({ status: "loaded", pele }),
      (): PeleLoad => ({ status: "failed" }),
    );
    diagramLoads.set(type, load);
  }
  return load;
}

function detectDiagramType(pele: Pele, source: string): DiagramType | null {
  try {
    return pele.detectType(source);
  } catch {
    return null;
  }
}

let mathLoad: Promise<MathResolver | null> | null = null;

// Pele has no typesetter, so $$...$$ labels go through the KaTeX the chat
// already uses for math. It only loads for diagrams that contain math.
function loadMath(): Promise<MathResolver | null> {
  mathLoad ??= import("katex").then(
    ({ default: katex }) => {
      const typeset = new Map<string, ReturnType<MathResolver>>();
      let probe: HTMLDivElement | null = null;
      // Pele calls this on every layout, including resizes.
      return (tex, size) => {
        const key = `${size}:${tex}`;
        if (typeset.has(key)) return typeset.get(key);
        let markup: ReturnType<MathResolver> = null;
        try {
          if (!probe) {
            probe = document.createElement("div");
            probe.style.cssText =
              "position:absolute;left:-9999px;visibility:hidden;display:inline-block;white-space:nowrap";
            document.body.append(probe);
          }
          probe.style.fontSize = `${size}px`;
          probe.innerHTML = katex.renderToString(tex, {
            displayMode: true,
            output: "mathml",
            throwOnError: true,
            // No \href, \url, \htmlClass, or other commands that emit active HTML.
            trust: false,
            strict: "ignore",
            maxSize: 20,
            maxExpand: 1000,
          });
          const expression = probe.querySelector("math");
          // The annotation repeats the TeX source; the sanitizer would keep its text.
          expression?.querySelector("annotation")?.remove();
          if (expression) {
            const { width, height } = expression.getBoundingClientRect();
            markup = { html: expression.outerHTML, width, height };
          }
        } catch {
          // Unsupported TeX stays readable as its source.
        }
        typeset.set(key, markup);
        return markup;
      };
    },
    () => null,
  );
  return mathLoad;
}

// MathML element types KaTeX emits, without annotation (the resolver removes it),
// semantics (only a wrapper, so its content is kept), and mglyph (an image).
const KATEX_MATHML_TAGS = new Set([
  "math",
  "menclose",
  "mfrac",
  "mi",
  "mlabeledtr",
  "mn",
  "mo",
  "mover",
  "mpadded",
  "mphantom",
  "mroot",
  "mrow",
  "mspace",
  "msqrt",
  "mstyle",
  "msub",
  "msubsup",
  "msup",
  "mtable",
  "mtd",
  "mtext",
  "mtr",
  "munder",
  "munderover",
]);
// Presentation attributes KaTeX sets on those elements. The profiles already
// cover class, style, width, height, display, and xmlns.
const KATEX_MATHML_ATTRIBUTES = new Set([
  "accent",
  "accentunder",
  "columnalign",
  "columnlines",
  "columnspacing",
  "depth",
  "displaystyle",
  "fence",
  "largeop",
  "linebreak",
  "linethickness",
  "lspace",
  "mathbackground",
  "mathcolor",
  "mathsize",
  "mathvariant",
  "maxsize",
  "minsize",
  "notation",
  "rowlines",
  "rowspacing",
  "rspace",
  "scriptlevel",
  "separator",
  "stretchy",
  "voffset",
]);

let purifier: ReturnType<typeof DOMPurify> | null = null;

// One sanitizer for both diagram kinds. Inline styles and presentation attributes keep
// only references inside the diagram (arrow markers, gradients): a url() to anywhere
// else, or a CSS escape that could spell one, would fetch a remote image, so the
// attribute is dropped.
function diagramPurifier(): ReturnType<typeof DOMPurify> {
  if (purifier) return purifier;
  purifier = DOMPurify(window);
  purifier.addHook("uponSanitizeAttribute", (_node, data) => {
    if (attributeMayFetch(data.attrValue)) data.keepAttr = false;
  });
  return purifier;
}

// Diagrams can come from untrusted text. Pele escapes labels, and links and
// images are off, so this is defense in depth against anything that could
// navigate, run script, or fetch remote content.
function sanitizeDiagramSvg(svg: string): Node {
  return diagramPurifier().sanitize(svg, {
    FORBID_ATTR: ["href", "xlink:href", "src", "srcset"],
    FORBID_TAGS: ["a", "image", "foreignObject", "style"],
    USE_PROFILES: { svg: true, svgFilters: true },
    RETURN_DOM_FRAGMENT: true,
  });
}

// Pele puts MathML labels in a <foreignObject> with an HTML <div> around them.
function sanitizeMathDiagramSvg(svg: string): Node {
  return diagramPurifier().sanitize(svg, {
    // DOMPurify still only accepts <math> under an HTML parent and checks every
    // MathML child's namespace.
    ADD_TAGS: ["foreignObject", ...KATEX_MATHML_TAGS],
    ADD_ATTR: (attribute, tagName) =>
      KATEX_MATHML_TAGS.has(tagName) && KATEX_MATHML_ATTRIBUTES.has(attribute),
    HTML_INTEGRATION_POINTS: { foreignobject: true },
    FORBID_ATTR: ["href", "xlink:href", "src", "srcset"],
    FORBID_TAGS: ["a", "img", "image", "script", "style"],
    USE_PROFILES: { svg: true, svgFilters: true, html: true },
    RETURN_DOM_FRAGMENT: true,
  });
}

// Pele colors diagrams through these, which a standalone image cannot inherit.
const PELE_COLOR_VARIABLES = [
  "--pele-bg",
  "--pele-fg",
  "--pele-muted",
  "--pele-line",
  "--pele-surface",
  "--pele-surface-alt",
  "--pele-border",
  "--pele-accent",
  "--pele-critical",
  ...Array.from({ length: 8 }, (_, index) => `--pele-series-${index + 1}`),
];

let expandedImageUrl: string | null = null;

/**
 * A standalone copy of the drawn diagram for the image viewer. It keeps the
 * theme colors, and an explicit size: an SVG without width and height reports
 * a tiny natural size, which the viewer would show as a thumbnail. A blob URL,
 * unlike a data URL, passes the desktop connect-src policy save and copy use.
 */
function diagramImageUrl(svg: SVGSVGElement): string {
  const element = svg.cloneNode(true) as SVGSVGElement;
  const computed = getComputedStyle(svg);
  for (const name of PELE_COLOR_VARIABLES) {
    const value = computed.getPropertyValue(name).trim();
    if (value) element.style.setProperty(name, value);
  }
  const box = svg.getBoundingClientRect();
  const viewBox = svg.viewBox?.baseVal;
  const width = Math.max(box.width, viewBox?.width ?? 0);
  const height = width > 0 && box.width > 0 ? (box.height * width) / box.width : box.height;
  if (width > 0 && height > 0) {
    element.setAttribute("width", String(Math.round(width * 2)));
    element.setAttribute("height", String(Math.round(height * 2)));
  }
  element.style.maxWidth = "none";
  element.style.backgroundColor = getComputedStyle(document.body).backgroundColor;
  if (expandedImageUrl) URL.revokeObjectURL(expandedImageUrl);
  expandedImageUrl = URL.createObjectURL(
    new Blob([new XMLSerializer().serializeToString(element)], { type: "image/svg+xml" }),
  );
  return expandedImageUrl;
}

export function MermaidDiagram({
  source,
  onExpand,
}: {
  source: string;
  onExpand?: ((imageUrl: string) => void) | undefined;
}) {
  const { t, format } = useTranslation();
  const [, setAttempt] = useState(0);
  const [renderError, setRenderError] = useState<string | null>(null);
  const trimmedSource = source.trim();
  const core = use(loadCore());
  const type = core.status === "loaded" ? detectDiagramType(core.pele, trimmedSource) : null;
  const load = core.status === "loaded" && type ? use(loadDiagramType(core.pele, type)) : core;
  const math = trimmedSource.includes("$$") ? use(loadMath()) : null;
  const fallbackError = t("chat.markdown.mermaid.renderFailed");

  // Remounted only when the renderer, math support or source changes. A new ref
  // callback on every render would destroy and redraw the diagram each time the
  // rest of a streaming reply re-renders the block.
  const mountDiagram = useCallback(
    (container: HTMLSpanElement) => {
      if (load.status !== "loaded") return;
      const mounted = load.pele.mount(container, trimmedSource, {
        links: false,
        images: false,
        zoom: false,
        // Keep the author's direction; a wide diagram scales down to fit instead of turning vertical.
        autoDirection: false,
        ...(math ? { math, sanitize: sanitizeMathDiagramSvg } : { sanitize: sanitizeDiagramSvg }),
        onRender: () => setRenderError(null),
        onError: (error) => setRenderError(error instanceof Error ? error.message : fallbackError),
      });
      return () => mounted.destroy();
    },
    [load, math, trimmedSource, fallbackError],
  );

  if (load.status === "failed") {
    return (
      <DiagramError
        message={t("chat.markdown.mermaid.loadFailed")}
        source={source}
        onRetry={() => {
          if (core.status === "failed") coreLoad = null;
          if (type) diagramLoads.delete(type);
          setAttempt((attempt) => attempt + 1);
        }}
      />
    );
  }

  return (
    <div className="chat-markdown-mermaid overflow-x-auto" data-markdown-mermaid="">
      {renderError ? (
        <DiagramError
          message={format("chat.markdown.mermaid.error", { message: renderError })}
          source={source}
        />
      ) : null}
      <button
        type="button"
        aria-label={t("chat.markdown.mermaid.expand")}
        hidden={renderError !== null}
        disabled={!onExpand}
        className="block w-full cursor-zoom-in rounded-control focus-visible:outline-2 focus-visible:outline-ring disabled:cursor-default"
        onClick={(event) => {
          const svg = event.currentTarget.querySelector("svg");
          if (svg && onExpand) onExpand(diagramImageUrl(svg));
        }}
      >
        <span ref={mountDiagram} className="flex w-full justify-center" />
      </button>
    </div>
  );
}

function DiagramError({
  message,
  source,
  onRetry,
}: {
  message: string;
  source: string;
  onRetry?: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div>
      <div className="flex items-center justify-between gap-2">
        <p className="m-0 text-destructive text-ui-xs">{message}</p>
        {onRetry ? (
          <Button type="button" variant="ghost" size="xs" onClick={onRetry}>
            {t("chat.markdown.mermaid.retry")}
          </Button>
        ) : null}
      </div>
      <pre
        data-thread-find-ignore
        className="mt-2 mb-0 overflow-auto whitespace-pre-wrap font-mono text-ui-xs"
      >
        {source}
      </pre>
    </div>
  );
}

export default MermaidDiagram;
