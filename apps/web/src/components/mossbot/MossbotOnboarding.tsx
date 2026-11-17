// FILE: MossbotOnboarding.tsx
// Purpose: First-run onboarding on the Mossbot page (no assistants yet). One companion moves across a soft stage
//          while the steps change around it: meet it, see how it works, one job per assistant, give it a name and a
//          colour, pick what it helps with, pick its model, then it is created for real and the chat opens.
// Layer: Mossbot route UI
// Exports: MossbotOnboarding
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type RefObject,
} from "react";
import { useNavigate } from "@tanstack/react-router";
import { resolveNewConversationDefaultModelSelection, useAppSettings } from "~/appSettings";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { GroupModelRow } from "~/components/chat/group/GroupModelEffortRow";
import { COORDINATOR_COLOR_OPTIONS } from "~/components/chat/group/coordinatorAppearance";
import { MossLogo } from "~/components/MossLogo";
import { FolderIcon, SearchIcon, SparklesIcon, type LucideIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import { useMossbotPreferencesStore } from "~/mossbotPreferencesStore";
import { useWorkspacePathsStore } from "~/workspacePathsStore";
import { MOSSBOT_COMPANION_TONES } from "~/theme/mossbotCompanion";
import {
  MossbotCompanion,
  mossbotCompanionToneFor,
  type MossbotCompanionState,
} from "./MossbotCompanion";
import { useMossbotCopy } from "./mossbot.copy";
import { MOSSBOT_TEMPLATES } from "./mossbot.logic";
import { useMossbotCreation } from "./useMossbotCreation";
import "./mossbotOnboarding.css";

const STEPS = ["meet", "work", "team", "name", "purpose", "model", "create"] as const;
type Step = (typeof STEPS)[number];

/** Where the companion stands in each step, in stage pixels from the centre, and how big it is. */
type Spot = { x: number; y: number; s: number };
const SPOTS: Record<Step, { wide: Spot; narrow: Spot }> = {
  meet: { wide: { x: 0, y: -40, s: 1 }, narrow: { x: 0, y: -60, s: 1 } },
  work: { wide: { x: -248, y: 40, s: 0.72 }, narrow: { x: 0, y: -150, s: 0.55 } },
  team: { wide: { x: 0, y: 34, s: 0.82 }, narrow: { x: 0, y: 40, s: 0.72 } },
  name: { wide: { x: -150, y: 40, s: 1.1 }, narrow: { x: 0, y: -110, s: 0.8 } },
  purpose: { wide: { x: 0, y: -96, s: 0.55 }, narrow: { x: 0, y: -150, s: 0.5 } },
  model: { wide: { x: 0, y: -84, s: 0.6 }, narrow: { x: 0, y: -150, s: 0.5 } },
  create: { wide: { x: 0, y: -40, s: 1 }, narrow: { x: 0, y: -60, s: 1 } },
};

const STATE_BY_STEP: Record<Step, MossbotCompanionState> = {
  meet: "greeting",
  work: "working",
  team: "idle",
  name: "idle",
  purpose: "listening",
  model: "thinking",
  create: "working",
};

const TONE_LABELS: Record<string, string> = {
  moss: "Moss green",
  slate: "Slate",
  plum: "Plum",
  jade: "Jade",
  ochre: "Ochre",
  clay: "Clay",
  lake: "Lake",
  rust: "Rust",
};

const TEMPLATE_ICONS: Record<string, LucideIcon> = {
  personal: SparklesIcon,
  research: SearchIcon,
  projects: FolderIcon,
};

/** Small helpers shown on the "one job each" step: a colour and a job. */
const TEAM = [
  { color: "green", job: "Writes the weekly report every Friday", cls: "mbo-mini-1" },
  { color: "blue", job: "Looks things up for you", cls: "mbo-mini-2" },
  { color: "amber", job: "Keeps an eye on your projects", cls: "mbo-mini-3" },
  { color: "rose", job: "Sorts your to-dos every morning", cls: "mbo-mini-4" },
] as const;

const WORK_ROWS = [
  "Find sources and check them",
  "Write a short summary",
  "Turn it into to-dos",
  "Ask you before sending",
] as const;

function useStageFit(ref: RefObject<HTMLDivElement | null>) {
  const [fit, setFit] = useState({ k: 1, narrow: false });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      const { width, height } = el.getBoundingClientRect();
      const narrow = width < 600;
      const [w, h] = narrow ? [360, 620] : [680, 520];
      const k = Math.max(0.5, Math.min(width / w, height / h, 1.2));
      setFit({ k, narrow });
    };
    measure();
    if (typeof ResizeObserver !== "function") return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref]);
  return fit;
}

export function MossbotOnboarding({ onLeave }: { onLeave: () => void }) {
  const { t } = useMossbotCopy();
  const navigate = useNavigate();
  const { settings } = useAppSettings();
  const root = useWorkspacePathsStore((state) => state.groupsWorkspaceRoot);
  const defaultModel = useMemo(
    () => resolveNewConversationDefaultModelSelection(settings),
    [settings],
  );
  const setSkipped = useMossbotPreferencesStore((state) => state.setOnboardingSkipped);

  const [index, setIndex] = useState(0);
  const step = STEPS[index] ?? "meet";
  const [name, setName] = useState(() => t("Little Moss"));
  const [color, setColor] = useState("default");
  const [templateId, setTemplateId] = useState<string>("personal");
  const [model, setModel] = useState(defaultModel);
  const [createdThreadId, setCreatedThreadId] = useState<string | null>(null);
  const creation = useMossbotCreation((overview) => {
    setCreatedThreadId(overview.config?.coordinatorThreadId ?? null);
  });

  const wrapRef = useRef<HTMLDivElement>(null);
  const { k, narrow } = useStageFit(wrapRef);
  const spot = SPOTS[step][narrow ? "narrow" : "wide"];
  const created = createdThreadId !== null;
  const companionState: MossbotCompanionState =
    step === "create"
      ? created
        ? "done"
        : creation.error
          ? "error"
          : "working"
      : STATE_BY_STEP[step];

  const template = MOSSBOT_TEMPLATES.find((item) => item.id === templateId) ?? MOSSBOT_TEMPLATES[0];
  const nameOk = name.trim().length > 0 && name.trim().length <= 160;

  const runCreate = () =>
    void creation.create({
      name: name.trim(),
      instructions: t(template.instructions),
      model,
      avatar: "mossbot-pebble",
      color: color === "default" ? "" : color,
    });

  const go = (next: number) => {
    const target = Math.max(0, Math.min(STEPS.length - 1, next));
    setIndex(target);
    if (STEPS[target] === "create" && !created) runCreate();
  };

  const skip = async () => {
    if (creation.busy) return;
    const outcome = await creation.abandon(name);
    if (outcome === "closed") {
      setSkipped(true);
      onLeave();
    }
  };

  const openChat = () => {
    onLeave();
    if (createdThreadId) void navigate({ to: "/$threadId", params: { threadId: createdThreadId } });
  };

  // Step "meet": a message is typed into an illustrative composer.
  const greeting = t("Help me sort out this week's to-dos");
  const [typed, setTyped] = useState(0);
  useEffect(() => {
    if (step !== "meet") return;
    setTyped(0);
    let n = 0;
    const timer = window.setInterval(() => {
      n += 1;
      setTyped(n);
      if (n >= greeting.length + 6) window.clearInterval(timer);
    }, 90);
    return () => window.clearInterval(timer);
  }, [step, greeting]);

  // Step "work": the rows tick off one by one; the last one waits for you.
  const [ticked, setTicked] = useState(0);
  useEffect(() => {
    if (step !== "work") return;
    setTicked(0);
    let n = 0;
    const timer = window.setInterval(() => {
      n += 1;
      setTicked(n);
      if (n >= WORK_ROWS.length) window.clearInterval(timer);
    }, 900);
    return () => window.clearInterval(timer);
  }, [step]);

  const stageStyle = { "--k": k } as CSSProperties;
  const botStyle = { "--x": `${spot.x}px`, "--y": `${spot.y}px`, "--s": spot.s } as CSSProperties;

  return (
    <div className="mbo" data-mossbot-onboarding data-step={step}>
      <div className="mbo-wall" aria-hidden="true" />
      <header className="mbo-top">
        <span className="mbo-brand">
          <MossLogo className="size-5" />
          Moss
        </span>
        {!created && (
          <Button
            variant="glass"
            size="sm"
            shape="capsule"
            disabled={creation.busy}
            onClick={() => void skip()}
          >
            {t("Skip intro")}
          </Button>
        )}
      </header>

      <div className="mbo-wrap" ref={wrapRef}>
        <div className={cn("mbo-stage", narrow && "mbo-narrow")} style={stageStyle}>
          <section
            className="mbo-scene"
            data-on={step === "meet" || undefined}
            aria-hidden={step !== "meet"}
          >
            <h1 className="mbo-title mbo-rise">{t("Meet your Moss assistant")}</h1>
            <div className="mbo-pin mbo-card mbo-composer mbo-rise" aria-hidden="true">
              <div className={cn("mbo-composer-text", typed === 0 && "mbo-placeholder")}>
                {typed === 0 ? t("Message your Moss assistant") : greeting.slice(0, typed)}
              </div>
              <div className="mbo-composer-row">
                <span className="mbo-chip">
                  <i />
                  {t("Your Moss assistant")}
                </span>
                <span className={cn("mbo-send", typed < greeting.length && "mbo-idle")} />
              </div>
            </div>
          </section>

          <section
            className="mbo-scene"
            data-on={step === "work" || undefined}
            aria-hidden={step !== "work"}
          >
            <h1 className="mbo-title mbo-rise">
              {t("It works for you, and asks before what matters")}
            </h1>
            <p className="mbo-sub mbo-rise">
              {t(
                "It researches, writes and follows up step by step, and checks with you before sending or deleting anything.",
              )}
            </p>
            <div className="mbo-pin mbo-card mbo-tasks mbo-rise" aria-hidden="true">
              {WORK_ROWS.map((row, i) => {
                const last = i === WORK_ROWS.length - 1;
                const state = i < ticked ? (last ? "wait" : "done") : "todo";
                return (
                  <div key={row} className="mbo-task" data-state={state}>
                    <span className="mbo-task-mark" />
                    <span>{t(row)}</span>
                  </div>
                );
              })}
            </div>
          </section>

          <section
            className="mbo-scene"
            data-on={step === "team" || undefined}
            aria-hidden={step !== "team"}
          >
            <h1 className="mbo-title mbo-rise">{t("Each assistant takes care of one thing")}</h1>
            <p className="mbo-sub mbo-rise">
              {t(
                "You can have several, each with its own job, and bring them into one group chat to work together.",
              )}
            </p>
            {TEAM.map((member) => (
              <div key={member.cls} className={cn("mbo-mini", member.cls)} aria-hidden="true">
                <div className="mbo-float">
                  <div className="mbo-card mbo-bubble">{t(member.job)}</div>
                  <MossbotCompanion
                    tone={mossbotCompanionToneFor(member.color)}
                    className="mbo-mini-bot"
                  />
                </div>
              </div>
            ))}
          </section>

          <section
            className="mbo-scene"
            data-on={step === "name" || undefined}
            aria-hidden={step !== "name"}
          >
            <h1 className="mbo-title mbo-rise">{t("Give it a name")}</h1>
            <div className="mbo-pin mbo-card mbo-face mbo-rise">
              <label className="mbo-label" htmlFor="mbo-name">
                {t("Name")}
              </label>
              <Input
                id="mbo-name"
                value={name}
                maxLength={40}
                onChange={(event) => setName(event.target.value)}
              />
              <span className="mbo-label">{t("Colour")}</span>
              <div className="mbo-swatches" role="group" aria-label={t("Colour")}>
                {COORDINATOR_COLOR_OPTIONS.map((option) => (
                  <Button
                    key={option.key}
                    variant="ghost"
                    size="icon-sm"
                    aria-label={t(TONE_LABELS[mossbotCompanionToneFor(option.key)] ?? option.label)}
                    aria-pressed={color === option.key}
                    className="mbo-swatch"
                    style={
                      {
                        "--c": MOSSBOT_COMPANION_TONES[mossbotCompanionToneFor(option.key)].body,
                      } as CSSProperties
                    }
                    onClick={() => setColor(option.key)}
                  />
                ))}
              </div>
            </div>
          </section>

          <section
            className="mbo-scene"
            data-on={step === "purpose" || undefined}
            aria-hidden={step !== "purpose"}
          >
            <h1 className="mbo-title mbo-rise">{t("What should it help you with most?")}</h1>
            <div
              className="mbo-pin mbo-choices"
              role="radiogroup"
              aria-label={t("What should it help you with most?")}
            >
              {MOSSBOT_TEMPLATES.map((item, i) => {
                const Icon = TEMPLATE_ICONS[item.id] ?? SparklesIcon;
                return (
                  <Button
                    key={item.id}
                    variant="glass"
                    role="radio"
                    aria-checked={templateId === item.id}
                    className="mbo-choice mbo-rise"
                    style={{ "--d": `${80 + i * 60}ms` } as CSSProperties}
                    onClick={() => setTemplateId(item.id)}
                  >
                    <Icon />
                    <span className="mbo-choice-text">
                      <span>{t(item.name)}</span>
                      <small>{t(item.description)}</small>
                    </span>
                    <span className="mbo-tick" />
                  </Button>
                );
              })}
            </div>
          </section>

          <section
            className="mbo-scene"
            data-on={step === "model" || undefined}
            aria-hidden={step !== "model"}
          >
            <h1 className="mbo-title mbo-rise">{t("Choose the model it thinks with")}</h1>
            <div className="mbo-pin mbo-card mbo-model mbo-rise">
              <GroupModelRow
                title={t("CLI & model")}
                description={t("Any provider set up in Moss works. You can change it later.")}
                selection={model}
                defaultSelection={defaultModel}
                projectCwd={root ?? ""}
                onChange={setModel}
              />
            </div>
          </section>

          <section
            className="mbo-scene"
            data-on={step === "create" || undefined}
            aria-hidden={step !== "create"}
          >
            <h1 className="mbo-title mbo-rise">
              {created
                ? t("All set")
                : creation.error
                  ? t("Setup didn't finish")
                  : t("Getting ready")}
            </h1>
            {!created && !creation.error && (
              <div className="mbo-pin mbo-progress" aria-live="polite">
                <div className="mbo-progress-msg">{t("Setting up its workspace…")}</div>
                <div className="mbo-track">
                  <div className="mbo-fill" />
                </div>
              </div>
            )}
            {created && (
              <div className="mbo-pin mbo-card mbo-say" aria-live="polite">
                {t(
                  "Hi, I'm {name}. Tell me what you'd like to get done, and I'll take it from there.",
                ).replace("{name}", name.trim())}
              </div>
            )}
            {creation.error && !created && (
              <p role="alert" className="mbo-pin mbo-card mbo-say mbo-error">
                {t(creation.error)}
              </p>
            )}
            <div className="mbo-pin mbo-endbtns">
              {created ? (
                <Button shape="capsule" onClick={openChat}>
                  {t("Start chatting")}
                </Button>
              ) : creation.error ? (
                <>
                  <Button shape="capsule" disabled={creation.busy} onClick={runCreate}>
                    {t("Try again")}
                  </Button>
                  <Button
                    variant="glass"
                    shape="capsule"
                    disabled={creation.busy}
                    onClick={() => setIndex(STEPS.indexOf("model"))}
                  >
                    {t("Back")}
                  </Button>
                </>
              ) : null}
            </div>
          </section>

          <div className="mbo-bot" style={botStyle} aria-hidden="true">
            <MossbotCompanion
              live
              interactive
              tone={mossbotCompanionToneFor(color)}
              state={companionState}
              className="mbo-bot-body"
            />
          </div>
        </div>
      </div>

      <nav className={cn("mbo-nav", step === "create" && "mbo-gone")} aria-label={t("Intro steps")}>
        <div className="mbo-nav-side">
          {index > 0 && (
            <Button variant="glass" shape="capsule" onClick={() => go(index - 1)}>
              {t("Previous")}
            </Button>
          )}
        </div>
        <div className="mbo-dots" aria-hidden="true">
          {STEPS.slice(0, -1).map((item, i) => (
            <i key={item} data-on={i === index || undefined} />
          ))}
        </div>
        <div className="mbo-nav-side mbo-nav-end">
          <Button
            shape="capsule"
            disabled={(step === "name" && !nameOk) || creation.busy}
            onClick={() => go(index + 1)}
          >
            {step === "model" ? t("Create assistant") : t("Next")}
          </Button>
        </div>
      </nav>
    </div>
  );
}
