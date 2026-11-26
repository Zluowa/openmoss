import { HitArea } from "~/components/ui/hit-area";
import type { SVGProps } from "react";
import { cn } from "~/lib/utils";
import {
  MossbotCompanion,
  MossbotCompanionStill,
  mossbotCompanionToneFor,
  type MossbotCompanionState,
} from "./MossbotCompanion";
import { useMossbotCopy } from "./mossbot.copy";
import { MOSSBOT_DEFAULT_AVATAR_KEY } from "./mossbot.logic";
import { MossbotKid, MossbotKidStill, mossbotKidToneFor } from "./kid/MossbotKid";
import type { MossbotKidForm } from "./kid/mossbotKidSprite";
import "./mossbot.css";

// The pinwheel kid (风车娃) is the original Mossbot body; an assistant chooses one of its forms and wears it in the
// assistant's colour. Keys are "mossbot-kid-<form>".
const KID_FORMS: ReadonlyArray<{ form: MossbotKidForm; label: string }> = [
  { form: "block", label: "Block kid" },
  { form: "cat", label: "Cat kid" },
  { form: "robot", label: "Robot kid" },
  { form: "dog", label: "Dog kid" },
  { form: "chick", label: "Chick kid" },
  { form: "penguin", label: "Penguin kid" },
];
const KID_KEY_PREFIX = "mossbot-kid-";

// The 16 × 16 pixel faces the kid replaces. Assistants that saved one now show the default kid.
const RETIRED_AVATAR_KEYS = new Set([
  "mossbot-sprout",
  "mossbot-orbit",
  "mossbot-bloom",
  "mossbot-lantern",
  "mossbot-moth",
  "mossbot-cloud",
  "mossbot-fox",
]);

// Rounded companions follow the supplied group references.
function RoundedCompanion({
  shape,
  ...props
}: SVGProps<SVGSVGElement> & { shape: "spark" | "prism" | "drop" }) {
  const forms = {
    spark:
      "M22 9C8 9 6 21 8 34L10 55C11 68 20 73 34 71L57 69C70 68 75 57 72 45L68 22C66 10 55 5 43 8Z",
    prism:
      "M35 5Q40 2 46 6L69 20Q75 24 74 32L72 57Q72 64 65 68L44 78Q39 80 33 76L12 63Q6 59 7 51L9 27Q9 19 16 15Z",
    drop: "M14 19C19 6 31 6 44 13L65 26C78 34 78 47 70 59C62 73 49 77 36 70L15 57C3 50 6 35 14 19Z",
  };
  return (
    <svg viewBox="0 0 82 82" fill="none" aria-hidden="true" {...props}>
      <path d={forms[shape]} fill="currentColor" />
      <g transform={shape === "drop" ? "rotate(24 41 41)" : "rotate(-9 41 41)"} fill="#092b25">
        <rect x="25" y="27" width="11" height="25" rx="5.5" />
        <rect x="46" y="27" width="11" height="25" rx="5.5" />
      </g>
      <path
        d="M20 17Q30 10 42 14"
        stroke="#c0ffe1"
        strokeOpacity=".25"
        strokeWidth="3"
        strokeLinecap="round"
      />
    </svg>
  );
}
function MossbotSpark(props: SVGProps<SVGSVGElement>) {
  return <RoundedCompanion shape="spark" {...props} />;
}
function MossbotPrism(props: SVGProps<SVGSVGElement>) {
  return <RoundedCompanion shape="prism" {...props} />;
}
function MossbotDrop(props: SVGProps<SVGSVGElement>) {
  return <RoundedCompanion shape="drop" {...props} />;
}

function MossbotCompanionIcon(props: SVGProps<SVGSVGElement>) {
  return <MossbotCompanionStill {...props} />;
}

/** The vector companion, a moss-green ball with a sprout. The stored key stays "mossbot-pebble". */
export const MOSSBOT_COMPANION_AVATAR_KEY = "mossbot-pebble";

export const MOSSBOT_AVATARS = [
  ...KID_FORMS.map(({ form, label }) => ({
    key: `${KID_KEY_PREFIX}${form}`,
    label,
    tone: "default",
    Icon: (props: SVGProps<SVGSVGElement>) => <MossbotKidStill form={form} {...props} />,
  })),
  { key: MOSSBOT_COMPANION_AVATAR_KEY, label: "Moss", tone: "default", Icon: MossbotCompanionIcon },
  { key: "mossbot-spark", label: "Spark", tone: "mint", Icon: MossbotSpark },
  { key: "mossbot-prism", label: "Prism", tone: "jade", Icon: MossbotPrism },
  { key: "mossbot-drop", label: "Drop", tone: "teal", Icon: MossbotDrop },
] as const;

/** The avatar an assistant shows: its saved key, or the default kid for an empty, unknown or retired one. */
function resolveAvatar(icon: string | null | undefined) {
  const key = icon && !RETIRED_AVATAR_KEYS.has(icon) ? icon : MOSSBOT_DEFAULT_AVATAR_KEY;
  return (
    MOSSBOT_AVATARS.find((item) => item.key === key) ??
    MOSSBOT_AVATARS.find((item) => item.key === MOSSBOT_DEFAULT_AVATAR_KEY)!
  );
}

/** The kid an assistant wears, or null when it wears another face. */
export function mossbotKidAppearance(
  icon: string | null | undefined,
  color: string | null | undefined,
): { form: MossbotKidForm; tone: ReturnType<typeof mossbotKidToneFor> } | null {
  const { key } = resolveAvatar(icon);
  if (!key.startsWith(KID_KEY_PREFIX)) return null;
  return {
    form: key.slice(KID_KEY_PREFIX.length) as MossbotKidForm,
    tone: mossbotKidToneFor(color),
  };
}

export function MossbotAvatar(props: {
  icon?: string | null | undefined;
  color?: string | null | undefined;
  className?: string;
  /** What the assistant is doing; the kid and the companion show it. */
  state?: MossbotCompanionState | undefined;
  /** Animate the kid or the companion (header, profile, a row that is working). Off by default: lists stay still. */
  live?: boolean | undefined;
  /** Clicking the companion makes it smile. */
  interactive?: boolean | undefined;
}) {
  const { key, Icon, tone } = resolveAvatar(props.icon);
  if (key.startsWith(KID_KEY_PREFIX)) {
    return (
      <MossbotKid
        data-mossbot-avatar
        data-tone={props.color || tone}
        form={key.slice(KID_KEY_PREFIX.length) as MossbotKidForm}
        tone={mossbotKidToneFor(props.color)}
        state={props.state ?? "idle"}
        live={props.live ?? false}
        className={cn("mossbot-avatar size-9 shrink-0", props.className)}
      />
    );
  }
  if (key === MOSSBOT_COMPANION_AVATAR_KEY) {
    return (
      <MossbotCompanion
        data-mossbot-avatar
        data-tone={props.color || tone}
        tone={mossbotCompanionToneFor(props.color)}
        state={props.state ?? "idle"}
        live={props.live ?? false}
        interactive={props.interactive ?? false}
        className={cn("mossbot-avatar size-9 shrink-0", props.className)}
      />
    );
  }
  return (
    <Icon
      data-mossbot-avatar
      data-tone={props.color || tone}
      className={cn("mossbot-avatar size-9 shrink-0", props.className)}
    />
  );
}

export function MossbotAvatarPicker(props: {
  value: string;
  color?: string;
  onChange: (value: string) => void;
  disabled?: boolean;
}) {
  const { t } = useMossbotCopy();
  const selectedKey = resolveAvatar(props.value).key;
  return (
    <div role="group" aria-label={t("Assistant avatar")} className="flex flex-wrap gap-2">
      {MOSSBOT_AVATARS.map((avatar) => (
        <HitArea
          key={avatar.key}
          type="button"
          disabled={props.disabled ?? false}
          aria-label={t(avatar.label)}
          aria-pressed={selectedKey === avatar.key}
          onClick={() => props.onChange(avatar.key)}
          className={cn(
            "mossbot-avatar-choice grid size-12 place-items-center rounded-card border border-transparent hover:bg-foreground/5 disabled:opacity-100",
            selectedKey === avatar.key && "border-foreground/15 bg-foreground/5",
          )}
        >
          <MossbotAvatar icon={avatar.key} color={props.color} className="size-8" />
        </HitArea>
      ))}
    </div>
  );
}
