import type { ComponentPropsWithoutRef, ReactNode } from "react";
import { cn } from "~/lib/utils";

export const TRANSCRIPT_NOTICE_BASE_CLASS_NAME =
  "relative isolate flex w-full overflow-hidden rounded-2xl border bg-surface py-2 ps-3 pe-2 text-ui-lg shadow-xs lg:mx-auto electron:border-0 electron:ring-[0.5px] electron:ring-border-strong";
export const TRANSCRIPT_NOTICE_BACKDROP_CLASS_NAME = "absolute inset-0 -z-10 bg-primary-soft";

export function TranscriptNotice(
  props: Omit<ComponentPropsWithoutRef<"section">, "children"> & {
    as?: "aside" | "section";
    children?: ReactNode;
    density?: "compact" | "default";
    tone?: "infoAccent" | "normal";
  },
) {
  const {
    as = "section",
    children,
    className,
    density = "compact",
    tone = "infoAccent",
    ...sectionProps
  } = props;
  const Notice = as;
  return (
    <Notice
      {...sectionProps}
      className={cn(
        TRANSCRIPT_NOTICE_BASE_CLASS_NAME,
        density === "default" && "rounded-panel py-4 ps-5 pe-3",
        tone === "normal" && "border-primary-outline",
        className,
      )}
    >
      <div
        aria-hidden="true"
        className={cn(TRANSCRIPT_NOTICE_BACKDROP_CLASS_NAME, tone === "normal" && "bg-transparent")}
      />
      {children}
    </Notice>
  );
}
