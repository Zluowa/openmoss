// Optional enhancement for read-only code panes. Plain text remains immediately
// selectable while the shared highlighter loads, or when content is too large.
import { useEffect, useRef, useState } from "react";
import { useTheme } from "../hooks/useTheme";
import { resolveDiffThemeName } from "../lib/diffRendering";
import { MAX_SYNTAX_HIGHLIGHT_INPUT_CHARS } from "../lib/syntaxHighlighting.constants";

export function HighlightedCodeText({ code, language }: { code: string; language: string }) {
  const { resolvedTheme } = useTheme();
  // The DOM class is the renderer's immediate source of truth. Browser parity
  // fixtures (and the first render during theme hydration) can project the
  // class before the external theme snapshot catches up; prefer it when present
  // so the syntax palette never lags behind the surface background.
  const domTheme =
    typeof document !== "undefined" &&
    (document.documentElement.classList.contains("dark") ||
      document.body?.classList.contains("dark"))
      ? "dark"
      : null;
  const themeName = resolveDiffThemeName(domTheme ?? resolvedTheme);
  const elementRef = useRef<HTMLSpanElement>(null);
  const [visible, setVisible] = useState(false);
  const [highlight, setHighlight] = useState<{
    code: string;
    language: string;
    themeName: string;
    html: string;
  } | null>(null);

  useEffect(() => {
    const element = elementRef.current;
    if (!element) return;
    if (typeof IntersectionObserver === "undefined") {
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting && entry.intersectionRect.height > 0))
          return;
        setVisible(true);
        observer.disconnect();
      },
      { rootMargin: "600px 0px" },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!visible || code.length > MAX_SYNTAX_HIGHLIGHT_INPUT_CHARS) return;
    let disposed = false;
    // Coalesce rapidly changing JSON; never let an older async result replace
    // the new contents or a newer theme. All failure paths keep the plain text.
    const timer = window.setTimeout(() => {
      void import("../lib/syntaxHighlighting")
        .then(async (syntax) => {
          if (disposed) return;
          const key = syntax.createSyntaxHighlightCacheKey(code, language, themeName);
          let html = syntax.getCachedSyntaxHighlightedHtml(key);
          if (html === null) {
            const highlighter = await syntax.getSyntaxHighlighterPromise(language);
            if (disposed) return;
            html = syntax.highlightCodeToHtmlWithFallback(highlighter, code, language, themeName);
            syntax.cacheSyntaxHighlightedHtml(key, html, code);
          }
          if (disposed) return;
          // Only markup produced by the escaping Shiki renderer is accepted.
          // Keep our existing code element, typography and scroll container.
          const body = /^<pre\b[^>]*><code\b[^>]*>([\s\S]*)<\/code><\/pre>$/.exec(html)?.[1];
          if (body !== undefined) setHighlight({ code, language, themeName, html: body });
        })
        .catch(() => undefined);
    }, 100);
    return () => {
      disposed = true;
      window.clearTimeout(timer);
    };
  }, [code, language, themeName, visible]);

  const html =
    highlight?.code === code && highlight.language === language && highlight.themeName === themeName
      ? highlight.html
      : null;
  return html === null ? (
    <span ref={elementRef}>{code}</span>
  ) : (
    <span
      ref={elementRef}
      data-syntax-highlighted="true"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
