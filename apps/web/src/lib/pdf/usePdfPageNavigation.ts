// Page navigation follows intersection ratios and pins smooth navigation until
// its target is reached, so the indicator does not flicker through every page.
import { useCallback, useEffect, useRef, useState } from "react";
import { resolvePdfCurrentPage } from "./pdfViewport";

export function usePdfPageNavigation(input: {
  scrollRoot: HTMLElement | null;
  numPages: number;
  enabled: boolean;
  resetKey: unknown;
}) {
  const { scrollRoot, numPages, enabled, resetKey } = input;
  const [state, setState] = useState({ resetKey, page: 1 });
  const currentPage = Object.is(state.resetKey, resetKey) ? state.page : 1;
  const elements = useRef(new Map<number, HTMLElement>());
  const pendingPage = useRef<number | null>(null);
  const settleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const observerRef = useRef<IntersectionObserver | null>(null);

  const registerElement = useCallback((pageNumber: number, element: HTMLElement | null) => {
    const old = elements.current.get(pageNumber);
    if (old) observerRef.current?.unobserve(old);
    if (element) {
      elements.current.set(pageNumber, element);
      observerRef.current?.observe(element);
    } else elements.current.delete(pageNumber);
  }, []);

  const scrollToPage = useCallback(
    (pageNumber: number, behavior: ScrollBehavior) => {
      const element = elements.current.get(pageNumber);
      if (!element || !scrollRoot) return;
      pendingPage.current = pageNumber;
      element.scrollIntoView({ behavior, block: "start" });
      setState({ resetKey, page: pageNumber });
    },
    [resetKey, scrollRoot],
  );

  const jumpToPage = useCallback(
    (pageNumber: number) => {
      scrollToPage(Math.min(Math.max(pageNumber, 1), Math.max(numPages, 1)), "smooth");
    },
    [numPages, scrollToPage],
  );

  useEffect(() => {
    if (!enabled || !scrollRoot) return;
    pendingPage.current = null;
    scrollRoot.scrollTo({ top: 0, left: 0, behavior: "auto" });
    const visibility = new Map<Element, number>();
    const update = (force = false) => {
      const rootTop = scrollRoot.getBoundingClientRect().top;
      const pages = Array.from(elements.current.entries())
        .sort(([a], [b]) => a - b)
        .map(([pageNumber, element]) => ({
          pageNumber,
          top: element.getBoundingClientRect().top - rootTop,
          intersectionRatio: visibility.get(element) ?? 0,
        }));
      const page = resolvePdfCurrentPage(pages);
      if (page === null) return;
      if (force || pendingPage.current === page) pendingPage.current = null;
      if (pendingPage.current === null) {
        setState((current) =>
          Object.is(current.resetKey, resetKey) && current.page === page
            ? current
            : { resetKey, page },
        );
      }
    };
    const observer =
      typeof IntersectionObserver === "undefined"
        ? null
        : new IntersectionObserver(
            (entries) => {
              for (const entry of entries) visibility.set(entry.target, entry.intersectionRatio);
              update();
            },
            { root: scrollRoot, threshold: [0, 0.25, 0.5, 0.75, 1] },
          );
    observerRef.current = observer;
    for (const element of elements.current.values()) observer?.observe(element);
    const onScroll = () => {
      if (settleTimer.current) clearTimeout(settleTimer.current);
      settleTimer.current = setTimeout(() => update(true), 100);
    };
    scrollRoot.addEventListener("scroll", onScroll, { passive: true });
    update();
    return () => {
      observer?.disconnect();
      observerRef.current = null;
      scrollRoot.removeEventListener("scroll", onScroll);
      if (settleTimer.current) clearTimeout(settleTimer.current);
      pendingPage.current = null;
    };
  }, [enabled, numPages, resetKey, scrollRoot]);

  return { currentPage, registerElement, jumpToPage, scrollToPage };
}
