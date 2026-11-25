// FILE: SlidesPresenter.tsx
// Purpose: 演示. The show fills the screen (from the current slide); "presenter" docks speaker
//          notes directly below the slide (resizable split starting at 50%, slide counter, next
//          slide title, elapsed timer with pause/reset), matching Claude's presenter layout, with
//          an optional pop-out button for a second screen. Keys: ←/→, PgUp/PgDn, Space, Home/End,
//          1–9 (+Enter for more digits), B/. black screen, W/, white screen, Shift+P notes, F
//          full screen, Esc to end. Hidden slides are skipped.
// Layer: 资料空间 幻灯片

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

import {
  bodyText,
  SLIDE_HEIGHT,
  SLIDE_WIDTH,
  type Slide,
  type SlidesDeck,
} from "@moss/shared/spaceItems/slidesDeck";

import { cn } from "~/lib/utils";
import { Button } from "../../ui/button";
import { BUILD_KEYFRAMES, buildSteps, SlideView } from "./SlideView";

const NEXT_KEYS = new Set(["ArrowRight", "ArrowDown", "PageDown", " ", "n", "N"]);
const PREVIOUS_KEYS = new Set(["ArrowLeft", "ArrowUp", "PageUp", "Backspace", "p", "P"]);

const slideTitle = (slide: Slide | undefined) => {
  const title = slide?.elements.find((e) => e.type === "text" && e.role === "title");
  return title && title.type === "text" ? bodyText(title.body).replaceAll("\n", " ") : "";
};
const clock = (ms: number) => {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return `${h ? `${h}:${String(m).padStart(2, "0")}` : m}:${String(s).padStart(2, "0")}`;
};

function useViewport(target: Window) {
  const [size, setSize] = useState({ width: target.innerWidth, height: target.innerHeight });
  useEffect(() => {
    const resize = () => setSize({ width: target.innerWidth, height: target.innerHeight });
    resize();
    target.addEventListener("resize", resize);
    return () => target.removeEventListener("resize", resize);
  }, [target]);
  return size;
}

/** One slide fitted into the area, with the slide's transition. */
function FittedSlide(props: {
  deck: SlidesDeck;
  slide: Slide | undefined;
  width: number;
  height: number;
  /** The build step showing (逐个出现); 0 before the first. */
  step?: number;
}) {
  const { slide } = props;
  const width = Math.min(props.width, (props.height * SLIDE_WIDTH) / SLIDE_HEIGHT);
  const [shown, setShown] = useState(true);
  useLayoutEffect(() => {
    if (!slide || slide.transition === "none") return;
    setShown(false);
    const frame = requestAnimationFrame(() => requestAnimationFrame(() => setShown(true)));
    return () => cancelAnimationFrame(frame);
  }, [slide?.id, slide?.transition]);
  if (!slide) return null;
  return (
    <div
      style={{
        opacity: shown ? 1 : 0,
        transform:
          !shown && slide.transition === "push"
            ? "translateX(6%)"
            : !shown && slide.transition === "wipe"
              ? "translateY(3%)"
              : "none",
        transition:
          slide.transition === "none" ? "none" : "opacity 360ms ease, transform 360ms ease",
      }}
    >
      <style>{BUILD_KEYFRAMES}</style>
      <SlideView
        slide={slide}
        theme={props.deck.theme}
        width={width}
        live
        build={{ step: props.step ?? 0 }}
      />
    </div>
  );
}

/** The speaker-notes panel (docked below the slide, or popped out to a second screen). */
function NotesView(props: {
  deck: SlidesDeck;
  current: Slide | undefined;
  next: Slide | undefined;
  position: number;
  count: number;
  elapsed: number;
  paused: boolean;
  onPause: () => void;
  onReset: () => void;
  onGo: (step: number) => void;
  onEnd: () => void;
  onPopout?: (() => void) | undefined;
  compact?: boolean | undefined;
}) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);
  const button = "text-white/90 hover:bg-white/15 hover:text-white";
  return (
    <div
      data-speaker-notes
      className={cn(
        "font-system-ui flex h-full flex-col bg-neutral-950 text-white",
        props.compact ? "gap-2 px-5 py-3" : "gap-4 p-6",
      )}
    >
      <div className="flex flex-wrap items-center gap-2 tabular-nums">
        {props.compact ? (
          <>
            <span className="text-ui-sm font-medium">
              演讲备注 · 第 {props.position + 1} / {props.count} 张
            </span>
            <span className="min-w-0 truncate text-ui-sm text-white/70">
              下一张：{props.next ? slideTitle(props.next) || "（无标题）" : "已是最后一张"}
            </span>
          </>
        ) : (
          <span className="text-xl font-medium">
            {now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
          </span>
        )}
        <div className={cn("flex items-center gap-1.5", props.compact ? "ml-auto" : "")}>
          {props.compact ? (
            <span className="text-ui-xs text-white/60">
              {now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
            </span>
          ) : null}
          <span className="text-ui-sm text-white/80">用时 {clock(props.elapsed)}</span>
          <Button size="xs" variant="ghost" className={button} onClick={props.onPause}>
            {props.paused ? "继续计时" : "暂停计时"}
          </Button>
          <Button size="xs" variant="ghost" className={button} onClick={props.onReset}>
            重新计时
          </Button>
          {props.compact && props.onPopout ? (
            <Button size="xs" variant="ghost" className={button} onClick={props.onPopout}>
              独立窗口
            </Button>
          ) : null}
        </div>
        {props.compact ? null : (
          <span className="ml-auto text-ui-sm text-white/70">
            第 {props.position + 1} 张，共 {props.count} 张
          </span>
        )}
      </div>
      {props.compact ? null : (
        <div className="flex min-h-0 gap-4">
          <div className="overflow-hidden rounded-card border border-white/15">
            {props.current ? (
              <SlideView slide={props.current} theme={props.deck.theme} width={420} />
            ) : null}
          </div>
          <div className="flex min-w-0 flex-col gap-2">
            <span className="text-ui-xs text-white/60">下一张</span>
            <span className="text-ui">
              {props.next ? slideTitle(props.next) || "（无标题）" : "已是最后一张"}
            </span>
            <div className="mt-auto flex gap-2">
              <Button size="xs" variant="ghost" className={button} onClick={() => props.onGo(-1)}>
                上一张
              </Button>
              <Button size="xs" variant="ghost" className={button} onClick={() => props.onGo(1)}>
                下一张
              </Button>
              <Button size="xs" variant="ghost" className={button} onClick={props.onEnd}>
                结束演示
              </Button>
            </div>
          </div>
        </div>
      )}
      <div
        className={cn(
          "min-h-0 flex-1 overflow-auto leading-relaxed whitespace-pre-wrap",
          props.compact ? "text-ui" : "text-lg",
          props.current?.notes ? "text-white" : "text-white/50",
        )}
      >
        {props.current?.notes || "这张幻灯片没有备注。"}
      </div>
    </div>
  );
}

export function SlidesPresenter(props: {
  deck: SlidesDeck;
  /** Index into deck.slides. */
  startIndex: number;
  /** "presenter" docks speaker notes below the slide (with optional second-screen popout). */
  surface?: "fullscreen" | "presenter" | "window";
  onClose: () => void;
}) {
  const { deck, onClose } = props;
  const [showNotes, setShowNotes] = useState(
    props.surface === "presenter" || props.surface === "window",
  );
  const [split, setSplit] = useState(0.5);
  const [blank, setBlank] = useState<"black" | "white" | null>(null);
  // Hidden (skipped) slides are left out of the show.
  const order = deck.slides.filter((slide) => !slide.hidden);
  const shown = order.length ? order : deck.slides;
  const start = deck.slides[Math.min(props.startIndex, deck.slides.length - 1)];
  const [position, setPosition] = useState(() => {
    const at = shown.findIndex((slide) => slide.id === start?.id);
    return at >= 0
      ? at
      : Math.max(
          0,
          shown.findIndex((slide) => deck.slides.indexOf(slide) >= props.startIndex),
        );
  });
  const last = shown.length - 1;
  // 逐个出现: `revealed` build groups of the current slide are showing.
  const [revealed, setRevealed] = useState(0);
  const go = useCallback(
    (next: number) => {
      setPosition(Math.max(0, Math.min(last, next)));
      setRevealed(0);
      setBlank(null);
    },
    [last],
  );
  const currentSlide = shown[position];
  const steps = useMemo(() => (currentSlide ? buildSteps(currentSlide) : []), [currentSlide]);
  const step = revealed > 0 ? (steps[revealed - 1] ?? 0) : 0;
  const forward = () => {
    setBlank(null);
    if (revealed < steps.length) setRevealed(revealed + 1);
    else go(position + 1);
  };
  const back = () => {
    setBlank(null);
    if (revealed > 0) setRevealed(revealed - 1);
    else go(position - 1);
  };
  // A group whose elements are all `auto` arrives by itself shortly after the one before.
  useEffect(() => {
    const slide = currentSlide;
    const nextOrder = steps[revealed];
    if (!slide || nextOrder === undefined) return;
    const group = slide.elements.filter((e) => e.build?.order === nextOrder);
    if (!group.length || !group.every((e) => e.build?.auto === true)) return;
    const timer = setTimeout(() => setRevealed((n) => n + 1), revealed === 0 ? 600 : 520);
    return () => clearTimeout(timer);
  }, [currentSlide, revealed, steps]);
  const root = useRef<HTMLDivElement>(null);
  const viewport = useViewport(window);
  const [controls, setControls] = useState(false);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const digits = useRef("");

  // Timer with pause (speaker notes).
  const [elapsedBase, setElapsedBase] = useState(0);
  const [runningSince, setRunningSince] = useState<number | null>(() => Date.now());
  const [, tick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, []);
  const elapsed = elapsedBase + (runningSince ? Date.now() - runningSince : 0);
  const togglePause = () => {
    if (runningSince) {
      setElapsedBase(elapsed);
      setRunningSince(null);
    } else setRunningSince(Date.now());
  };
  const resetTimer = () => {
    setElapsedBase(0);
    setRunningSince(Date.now());
  };

  // Optional second-screen speaker-notes window; default stays docked below the slide.
  const [notesRoot, setNotesRoot] = useState<HTMLElement | null>(null);
  const [notesWindow, setNotesWindow] = useState<Window | null>(null);
  const openNotesWindow = useCallback(() => {
    if (notesWindow && !notesWindow.closed) {
      notesWindow.focus();
      return;
    }
    const opened = window.open("", "moss-speaker-notes", "popup,width=960,height=640");
    if (!opened) return;
    opened.document.title = "演讲者备注";
    opened.document.body.style.margin = "0";
    opened.document.body.className = "bg-neutral-950 text-white";
    for (const node of document.querySelectorAll('link[rel="stylesheet"], style'))
      opened.document.head.appendChild(node.cloneNode(true));
    const mount = opened.document.createElement("div");
    mount.style.height = "100vh";
    opened.document.body.replaceChildren(mount);
    setNotesWindow(opened);
    setNotesRoot(mount);
  }, [notesWindow]);
  useEffect(() => {
    return () => {
      if (notesWindow && !notesWindow.closed) notesWindow.close();
    };
  }, [notesWindow]);

  // Full screen for the show.
  useLayoutEffect(() => {
    const element = root.current;
    if (element && !document.fullscreenElement)
      void element.requestFullscreen?.().catch(() => undefined);
    return () => {
      if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
    };
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (/^[0-9]$/u.test(event.key)) {
        digits.current += event.key;
        // A single digit jumps at once; Enter confirms longer numbers.
        if (digits.current.length === 1 && shown.length < 10) {
          go(Number(digits.current) - 1);
          digits.current = "";
        }
      } else if (event.key === "Enter" && digits.current) {
        go(Number(digits.current) - 1);
        digits.current = "";
      } else if (event.key === "Escape") onClose();
      else if (event.key === "P" && event.shiftKey) setShowNotes((value) => !value);
      else if (event.key === "b" || event.key === "B" || event.key === ".")
        setBlank((currentBlank) => (currentBlank === "black" ? null : "black"));
      else if (event.key === "w" || event.key === "W" || event.key === ",")
        setBlank((currentBlank) => (currentBlank === "white" ? null : "white"));
      else if (NEXT_KEYS.has(event.key) || event.key === "Enter") forward();
      else if (PREVIOUS_KEYS.has(event.key)) back();
      else if (event.key === "Home") go(0);
      else if (event.key === "End") go(last);
      else if (event.key === "f" || event.key === "F") {
        if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
        else void root.current?.requestFullscreen?.().catch(() => undefined);
      } else return;
      event.preventDefault();
    };
    const targets: Window[] = [window, ...(notesWindow ? [notesWindow] : [])];
    for (const target of targets) target.addEventListener("keydown", onKey, true);
    const onFullscreen = () => {
      // Leaving full screen with the system gesture ends the show too.
      if (!document.fullscreenElement && root.current?.dataset.wasFullscreen === "1") onClose();
      if (document.fullscreenElement && root.current) root.current.dataset.wasFullscreen = "1";
    };
    document.addEventListener("fullscreenchange", onFullscreen);
    return () => {
      for (const target of targets) target.removeEventListener("keydown", onKey, true);
      document.removeEventListener("fullscreenchange", onFullscreen);
    };
  }, [go, last, notesWindow, onClose, position, shown.length, revealed, steps.length]);

  useEffect(() => {
    if (!notesWindow) return;
    const timer = setInterval(() => {
      if (notesWindow.closed) {
        setNotesWindow(null);
        setNotesRoot(null);
      }
    }, 500);
    return () => clearInterval(timer);
  }, [notesWindow]);

  const current = shown[position];
  const next = shown[position + 1];
  const notesBelow = showNotes && !notesWindow;
  const stageHeight = notesBelow
    ? Math.max(120, Math.round(viewport.height * split))
    : viewport.height;
  const notesHeight = notesBelow ? Math.max(120, viewport.height - stageHeight) : 0;
  const notes = (compact: boolean) => (
    <NotesView
      deck={deck}
      current={current}
      next={next}
      position={position}
      count={shown.length}
      elapsed={elapsed}
      paused={runningSince === null}
      onPause={togglePause}
      onReset={resetTimer}
      onGo={(delta) => (delta < 0 ? back() : forward())}
      onEnd={onClose}
      onPopout={compact ? openNotesWindow : undefined}
      compact={compact}
    />
  );
  const button = "text-white/90 hover:bg-white/15 hover:text-white";
  return (
    <div
      ref={root}
      role="dialog"
      aria-modal="true"
      aria-label="幻灯片演示"
      className="fixed inset-0 z-[1000] flex flex-col bg-black"
      data-slides-presenter={
        notesWindow ? "notes-window" : notesBelow ? "notes-below" : "fullscreen"
      }
      onMouseMove={() => {
        setControls(true);
        if (hideTimer.current) clearTimeout(hideTimer.current);
        hideTimer.current = setTimeout(() => setControls(false), 2_000);
      }}
    >
      <div
        className="relative flex min-h-0 flex-1 cursor-interaction items-center justify-center"
        onClick={(event) => (event.clientX < window.innerWidth / 4 ? back() : forward())}
      >
        <FittedSlide
          deck={deck}
          slide={current}
          width={viewport.width}
          height={stageHeight}
          step={step}
        />
        {blank ? (
          <div
            className={cn(
              "pointer-events-none absolute inset-0",
              blank === "black" ? "bg-black" : "bg-white",
            )}
            data-present-blank={blank}
          />
        ) : null}
      </div>
      {notesBelow ? (
        <div
          className="flex shrink-0 flex-col border-t border-white/15"
          style={{ height: notesHeight }}
        >
          <div
            role="separator"
            aria-orientation="horizontal"
            aria-label="调整备注区高度"
            className="h-1.5 shrink-0 cursor-row-resize bg-white/5 hover:bg-white/20"
            onPointerDown={(event) => {
              event.preventDefault();
              const move = (ev: PointerEvent) =>
                setSplit(
                  Math.max(0.25, Math.min(0.8, ev.clientY / Math.max(1, window.innerHeight))),
                );
              const up = () => {
                window.removeEventListener("pointermove", move);
                window.removeEventListener("pointerup", up);
              };
              window.addEventListener("pointermove", move);
              window.addEventListener("pointerup", up);
            }}
          />
          <div className="min-h-0 flex-1">{notes(true)}</div>
        </div>
      ) : null}
      <div
        className="absolute bottom-4 left-4 flex items-center gap-1 rounded-card bg-black/70 p-1 tabular-nums transition-opacity"
        style={{ opacity: controls ? 1 : 0, bottom: notesHeight + 16 }}
        data-present-controls
      >
        <Button size="xs" variant="ghost" className={button} onClick={back} aria-label="上一张">
          ‹
        </Button>
        <span className="px-1 text-ui text-white/80">
          第 {position + 1} 张，共 {shown.length} 张
        </span>
        <Button size="xs" variant="ghost" className={button} onClick={forward} aria-label="下一张">
          ›
        </Button>
        <Button
          size="xs"
          variant="ghost"
          className={button}
          aria-pressed={showNotes}
          onClick={() => setShowNotes((value) => !value)}
        >
          备注
        </Button>
        <Button size="xs" variant="ghost" className={button} onClick={onClose}>
          结束
        </Button>
      </div>
      {notesRoot && notesWindow ? createPortal(notes(false), notesRoot) : null}
    </div>
  );
}
