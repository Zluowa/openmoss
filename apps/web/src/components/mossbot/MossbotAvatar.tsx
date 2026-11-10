import type { SVGProps } from "react";
import { cn } from "~/lib/utils";
import { useMossbotCopy } from "./mossbot.copy";
import "./mossbot.css";

// Existing identity keys remain stable. Moss follows the supplied rounded companion;
// the other original 16 × 16 sprites retain their crisp pixel silhouettes.
const FORMS = {
  pebble: "M5 3h6v1h2v2h1v6h-2v2h-2v-1H6v1H4v-2H2V6h1V4h2Z",
  sprout: "M3 1h3v1h2v3h1V2h2V1h3v3h-2v1h-2v2h3v2h1v4h-2v2H9v-1H7v1H4v-2H2V9h1V7h4V5H5V4H3Z",
  orbit:
    "M6 2h4v1h2v2h1v1h2v2h-2v3h-2v2H5v-1H3v-2H1V8h2V5h1V3h2Zm-4 9H0v2h3v-1H2Zm11-9h3v2h-2V3h-1Z",
  bloom: "M6 1h4v3h2V3h2v2h1v4h-3v2h1v3h-3v-2H8v3H5v-3H3v1H1v-3h3V8H1V5h3V2h2Z",
  lantern: "M6 1h4v2h2v2h2v7h-3v2H5v-2H2V5h2V3h2Zm0 4H5v1h6V5Zm1 9h2v2H7Z",
  moth: "M1 3h4v1h2V2h2v2h2V3h4v5h-2v2h1v3h-3v-2H9v3H7v-3H5v2H2v-3h1V8H1Z",
  cloud: "M6 2h4v1h2v3h2v2h1v4h-2v1H3v-1H1V8h1V6h3V3h1Zm-2 12h2v2H4Zm6 0h2v2h-2Z",
  fox: "M2 1h2v2h2v2h4V3h2V1h2v11h-2v2H4v-2H2Zm4 11v2h4v-2Z",
} as const;
type Shape = keyof typeof FORMS;

function CompanionGlyph({ shape, ...props }: SVGProps<SVGSVGElement> & { shape: Shape }) {
  return (
    <svg viewBox="0 0 16 16" fill="none" shapeRendering="crispEdges" aria-hidden="true" {...props}>
      <path d={FORMS[shape]} fill="currentColor" />
      <path d="M5 7h2v2H5Zm5 0h2v2h-2ZM7 11h3v1H7Z" fill="var(--background)" />
    </svg>
  );
}

/** The default assistant face (a picture, not the Mossbot mark: that is MossbotIcon). */
export function MossbotPebbleFace(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="-6 -6 92 92" fill="none" aria-hidden="true" {...props}>
      <g transform="rotate(-22 40 40)">
        <path
          d="M26 10C29-2 47-3 53 8C67 4 79 17 73 30C86 39 82 56 69 60C71 75 54 85 42 76C30 87 13 78 13 64C-2 59-3 42 9 34C3 21 14 8 26 10Z"
          fill="currentColor"
        />
        <rect x="29" y="30" width="9" height="20" rx="4.5" fill="#17151d" />
        <rect x="46" y="30" width="9" height="20" rx="4.5" fill="#17151d" />
      </g>
    </svg>
  );
}
export function MossbotSprout(props: SVGProps<SVGSVGElement>) {
  return <CompanionGlyph shape="sprout" {...props} />;
}
export function MossbotOrbit(props: SVGProps<SVGSVGElement>) {
  return <CompanionGlyph shape="orbit" {...props} />;
}
export function MossbotBloom(props: SVGProps<SVGSVGElement>) {
  return <CompanionGlyph shape="bloom" {...props} />;
}
function MossbotLantern(props: SVGProps<SVGSVGElement>) {
  return <CompanionGlyph shape="lantern" {...props} />;
}
function MossbotMoth(props: SVGProps<SVGSVGElement>) {
  return <CompanionGlyph shape="moth" {...props} />;
}
function MossbotCloud(props: SVGProps<SVGSVGElement>) {
  return <CompanionGlyph shape="cloud" {...props} />;
}
function MossbotFox(props: SVGProps<SVGSVGElement>) {
  return <CompanionGlyph shape="fox" {...props} />;
}

// New rounded companions follow the supplied group references; saved pixel identities stay valid.
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

export const MOSSBOT_AVATARS = [
  { key: "mossbot-pebble", label: "Moss", tone: "default", Icon: MossbotPebbleFace },
  { key: "mossbot-sprout", label: "Sprout", tone: "green", Icon: MossbotSprout },
  { key: "mossbot-orbit", label: "Orbit", tone: "blue", Icon: MossbotOrbit },
  { key: "mossbot-bloom", label: "Bloom", tone: "rose", Icon: MossbotBloom },
  { key: "mossbot-lantern", label: "Lantern", tone: "amber", Icon: MossbotLantern },
  { key: "mossbot-moth", label: "Moth", tone: "violet", Icon: MossbotMoth },
  { key: "mossbot-cloud", label: "Cloud", tone: "blue", Icon: MossbotCloud },
  { key: "mossbot-fox", label: "Fox", tone: "orange", Icon: MossbotFox },
  { key: "mossbot-spark", label: "Spark", tone: "mint", Icon: MossbotSpark },
  { key: "mossbot-prism", label: "Prism", tone: "jade", Icon: MossbotPrism },
  { key: "mossbot-drop", label: "Drop", tone: "teal", Icon: MossbotDrop },
] as const;

export function MossbotAvatar(props: {
  icon?: string | null | undefined;
  color?: string | null | undefined;
  className?: string;
}) {
  const { Icon, tone } =
    MOSSBOT_AVATARS.find((item) => item.key === props.icon) ?? MOSSBOT_AVATARS[0];
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
  const selectedKey =
    MOSSBOT_AVATARS.find((avatar) => avatar.key === props.value)?.key ?? MOSSBOT_AVATARS[0].key;
  return (
    <div role="group" aria-label={t("Assistant avatar")} className="flex flex-wrap gap-2">
      {MOSSBOT_AVATARS.map((avatar) => (
        <button
          key={avatar.key}
          type="button"
          disabled={props.disabled}
          aria-label={t(avatar.label)}
          aria-pressed={selectedKey === avatar.key}
          onClick={() => props.onChange(avatar.key)}
          className={cn(
            "mossbot-avatar-choice grid size-12 place-items-center rounded-xl border border-transparent hover:bg-foreground/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            selectedKey === avatar.key && "border-foreground/15 bg-foreground/5",
          )}
        >
          <MossbotAvatar icon={avatar.key} color={props.color} className="size-8" />
        </button>
      ))}
    </div>
  );
}
