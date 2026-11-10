// FILE: SlidesPresenter.tsx
// Purpose: 演示. The show fills the screen (from the current slide); "presenter" also opens a
//          separate speaker-notes window (clock, elapsed time with pause, the slide on screen,
//          the next slide's title and the notes); when that window is blocked the notes show
//          under the slide instead. Keys: ←/→, PgUp/PgDn, Space, Home/End, 1–9 (+Enter for
//          more digits), F full screen, Esc to end. Hidden slides are skipped. A control bar
//          (上一张 · 第 N 张，共 M 张 · 下一张 · 结束) appears when the pointer moves.
// Layer: 资料空间 幻灯片

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import {
  bodyText,
  SLIDE_HEIGHT,
  SLIDE_WIDTH,
  type Slide,
  type SlidesDeck,
} from "@moss/shared/spaceItems/slidesDeck";

import { SlideView } from "./SlideView";

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
      <SlideView slide={slide} theme={props.deck.theme} width={width} />
    </div>
  );
}

/** The speaker-notes window (or the panel under the slide when pop-ups are blocked). */
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
  compact?: boolean;
}) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);
  const button = "rounded-[6px] bg-white/10 px-3 py-1 text-ui text-white/90 hover:bg-white/20";
  return (
    <div
      data-speaker-notes
      style={{
        display: "flex",
        flexDirection: props.compact ? "row" : "column",
        gap: 16,
        padding: props.compact ? "12px 20px" : 24,
        height: "100%",
        boxSizing: "border-box",
        background: "#141414",
        color: "#fff",
        fontFamily:
          '"Inter Variable", Inter, "PingFang SC", "Microsoft YaHei", system-ui, sans-serif',
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          fontVariantNumeric: "tabular-nums",
        }}
      >
        <span style={{ fontSize: 28, fontWeight: 600 }}>
          {now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
        </span>
        <span style={{ fontSize: 20, color: "rgba(255,255,255,.7)" }}>{clock(props.elapsed)}</span>
        <button type="button" className={button} onClick={props.onPause}>
          {props.paused ? "继续计时" : "暂停计时"}
        </button>
        <button type="button" className={button} onClick={props.onReset}>
          重新计时
        </button>
        <span style={{ marginLeft: "auto", color: "rgba(255,255,255,.7)" }}>
          第 {props.position + 1} 张，共 {props.count} 张
        </span>
      </div>
      {props.compact ? null : (
        <div style={{ display: "flex", gap: 16, minHeight: 0 }}>
          <div
            style={{
              borderRadius: 8,
              overflow: "hidden",
              border: "1px solid rgba(255,255,255,.12)",
            }}
          >
            {props.current ? (
              <SlideView slide={props.current} theme={props.deck.theme} width={420} />
            ) : null}
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8, minWidth: 0 }}>
            <span style={{ fontSize: 13, color: "rgba(255,255,255,.6)" }}>下一张</span>
            <span style={{ fontSize: 15 }}>
              {props.next ? slideTitle(props.next) || "（无标题）" : "已是最后一张"}
            </span>
            <div style={{ display: "flex", gap: 8, marginTop: "auto" }}>
              <button type="button" className={button} onClick={() => props.onGo(-1)}>
                上一张
              </button>
              <button type="button" className={button} onClick={() => props.onGo(1)}>
                下一张
              </button>
              <button type="button" className={button} onClick={props.onEnd}>
                结束演示
              </button>
            </div>
          </div>
        </div>
      )}
      <div
        style={{
          flex: 1,
          minHeight: 0,
          overflow: "auto",
          fontSize: props.compact ? 16 : 22,
          lineHeight: 1.5,
          whiteSpace: "pre-wrap",
          color: props.current?.notes ? "#fff" : "rgba(255,255,255,.5)",
        }}
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
  /** "presenter" also opens the speaker-notes window. */
  surface?: "fullscreen" | "presenter" | "window";
  onClose: () => void;
}) {
  const { deck, onClose } = props;
  const withNotes = props.surface === "presenter" || props.surface === "window";
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
  const go = useCallback((next: number) => setPosition(Math.max(0, Math.min(last, next))), [last]);
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

  // The speaker-notes window; blocked → notes under the slide.
  const [notesRoot, setNotesRoot] = useState<HTMLElement | null>(null);
  const [notesWindow, setNotesWindow] = useState<Window | null>(null);
  const [notesBlocked, setNotesBlocked] = useState(false);
  useLayoutEffect(() => {
    if (!withNotes) return;
    const opened = window.open("", "moss-speaker-notes", "popup,width=960,height=640");
    if (!opened) {
      setNotesBlocked(true);
      return;
    }
    opened.document.title = "演讲者备注";
    opened.document.body.style.margin = "0";
    opened.document.body.style.background = "#141414";
    // Copy this window's styles so buttons in the notes window look like Moss.
    for (const node of document.querySelectorAll('link[rel="stylesheet"], style'))
      opened.document.head.appendChild(node.cloneNode(true));
    const mount = opened.document.createElement("div");
    mount.style.height = "100vh";
    opened.document.body.replaceChildren(mount);
    setNotesWindow(opened);
    setNotesRoot(mount);
    return () => {
      if (!opened.closed) opened.close();
    };
    // Once per show.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [withNotes]);

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
      else if (NEXT_KEYS.has(event.key) || event.key === "Enter") go(position + 1);
      else if (PREVIOUS_KEYS.has(event.key)) go(position - 1);
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
  }, [go, last, notesWindow, onClose, position, shown.length]);

  useEffect(() => {
    if (!notesWindow) return;
    const timer = setInterval(() => {
      if (notesWindow.closed) setNotesWindow(null);
    }, 500);
    return () => clearInterval(timer);
  }, [notesWindow]);

  const current = shown[position];
  const next = shown[position + 1];
  const notesBelow = withNotes && notesBlocked;
  const notesHeight = notesBelow ? Math.round(viewport.height * 0.22) : 0;
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
      onGo={(step) => go(position + step)}
      onEnd={onClose}
      compact={compact}
    />
  );
  const button = "rounded-[6px] px-2.5 py-1 text-ui text-white/90 hover:bg-white/15";
  return (
    <div
      ref={root}
      role="dialog"
      aria-modal="true"
      aria-label="幻灯片演示"
      className="fixed inset-0 z-[1000] flex flex-col bg-black"
      data-slides-presenter={
        withNotes ? (notesBlocked ? "notes-below" : "notes-window") : "fullscreen"
      }
      onMouseMove={() => {
        setControls(true);
        if (hideTimer.current) clearTimeout(hideTimer.current);
        hideTimer.current = setTimeout(() => setControls(false), 2_000);
      }}
    >
      <div
        className="flex min-h-0 flex-1 cursor-pointer items-center justify-center"
        onClick={(event) => go(position + (event.clientX < window.innerWidth / 4 ? -1 : 1))}
      >
        <FittedSlide
          deck={deck}
          slide={current}
          width={viewport.width}
          height={viewport.height - notesHeight}
        />
      </div>
      {notesBelow ? <div style={{ height: notesHeight }}>{notes(true)}</div> : null}
      <div
        className="absolute bottom-4 left-4 flex items-center gap-1 rounded-[10px] bg-black/70 p-1 tabular-nums transition-opacity"
        style={{ opacity: controls ? 1 : 0, bottom: notesHeight + 16 }}
        data-present-controls
      >
        <button
          type="button"
          className={button}
          onClick={() => go(position - 1)}
          aria-label="上一张"
        >
          ‹
        </button>
        <span className="px-1 text-ui text-white/80">
          第 {position + 1} 张，共 {shown.length} 张
        </span>
        <button
          type="button"
          className={button}
          onClick={() => go(position + 1)}
          aria-label="下一张"
        >
          ›
        </button>
        <button type="button" className={button} onClick={onClose}>
          结束
        </button>
      </div>
      {notesRoot && notesWindow ? createPortal(notes(false), notesRoot) : null}
    </div>
  );
}
