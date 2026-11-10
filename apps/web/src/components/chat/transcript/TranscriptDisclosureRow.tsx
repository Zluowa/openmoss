// FILE: TranscriptDisclosureRow.tsx
// Purpose: The desktop chat's quiet one-line disclosure ("Received message from X ▸"):
//          a muted verb, an optional subject, and a solid caret that turns a quarter when
//          open. The body mounts on first open and stays mounted (hidden) afterwards, so
//          its state survives collapsing.
// Layer: Chat transcript primitive
// Exports: TranscriptDisclosureRow, TranscriptEventLine, useTranscriptDisclosureState

import {
  useCallback,
  useId,
  useState,
  useSyncExternalStore,
  type ComponentProps,
  type ReactNode,
} from "react";

import { CaretRightFillIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import { disclosureChevronClassName } from "~/lib/disclosureMotion";
import { DisclosureRegion } from "../../ui/DisclosureRegion";
import { ConversationShimmer } from "../ConversationShimmer";

// Expansion survives row virtualization: a row scrolled out and back keeps its state.
const expandedByKey = new Map<string, boolean>();
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function setTranscriptDisclosureOpen(key: string, open: boolean): void {
  expandedByKey.set(key, open);
  for (const listener of listeners) listener();
}

/** Open state for one disclosure, keyed so it outlives the mounted row. */
export function useTranscriptDisclosureState(
  key: string,
  defaultOpen = false,
): [open: boolean, setOpen: (open: boolean) => void] {
  const open = useSyncExternalStore(
    subscribe,
    () => expandedByKey.get(key) ?? defaultOpen,
    () => defaultOpen,
  );
  const setOpen = useCallback((next: boolean) => setTranscriptDisclosureOpen(key, next), [key]);
  return [open, setOpen];
}

/**
 * The desktop chat's event line with no body ("Compacted session", "Switched model to
 * opus"): the disclosure row's tone and size, with the verb shimmering while busy.
 */
export function TranscriptEventLine(
  props: {
    verb: ReactNode;
    subject?: ReactNode;
    after?: ReactNode;
    busy?: boolean;
    className?: string;
  } & Omit<ComponentProps<"div">, "children">,
) {
  const { verb, subject, after, busy, className, ...rest } = props;
  return (
    <div
      {...rest}
      className={cn("flex w-full min-w-0 text-size-chat", className)}
      data-transcript-event=""
    >
      <div className="flex min-h-6 min-w-0 max-w-full items-center gap-1 text-muted-foreground">
        <span className="shrink-0 whitespace-nowrap">
          {busy ? <ConversationShimmer active>{verb}</ConversationShimmer> : verb}
        </span>
        {subject !== undefined ? (
          <span className="min-w-0 truncate text-foreground">{subject}</span>
        ) : null}
        {after !== undefined ? (
          <span className="shrink-0 whitespace-nowrap text-muted-foreground/80">{after}</span>
        ) : null}
      </div>
    </div>
  );
}

export function TranscriptDisclosureRow(props: {
  /** Lead words in the muted tone ("Received message from"). */
  verb: ReactNode;
  /** The thing acted on, in the primary tone; may hold its own button. */
  subject?: ReactNode;
  /** Trailing note in the muted tone ("running", "1 added, 0 removed"). */
  after?: ReactNode;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Accessible name of the caret toggle. */
  toggleLabel: string;
  /** Body; rendered only after the first open. */
  children?: ReactNode;
  className?: string;
}) {
  const { verb, subject, after, open, onOpenChange, toggleLabel, children, className } = props;
  const bodyId = useId();
  const [everOpened, setEverOpened] = useState(open);
  if (open && !everOpened) setEverOpened(true);
  const hasBody = children != null;
  return (
    <div
      className={cn("flex w-full min-w-0 flex-col text-size-chat", className)}
      data-transcript-disclosure=""
      data-open={open ? "" : undefined}
    >
      <div className="group/disclosure flex min-h-6 min-w-0 max-w-full items-center gap-1 self-start text-muted-foreground">
        <span className="shrink-0 whitespace-nowrap">{verb}</span>
        {subject !== undefined ? (
          <span className="min-w-0 truncate text-foreground">{subject}</span>
        ) : null}
        {after !== undefined ? (
          <span className="shrink-0 whitespace-nowrap text-muted-foreground/80">{after}</span>
        ) : null}
        {hasBody ? (
          <button
            type="button"
            aria-label={toggleLabel}
            aria-expanded={open}
            aria-controls={bodyId}
            data-transcript-disclosure-toggle=""
            onClick={() => onOpenChange(!open)}
            className="-m-0.75 flex shrink-0 cursor-interaction rounded-inline p-0.75 text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <CaretRightFillIcon aria-hidden className={disclosureChevronClassName(open)} />
          </button>
        ) : null}
      </div>
      {hasBody ? (
        <div id={bodyId}>
          <DisclosureRegion open={open} contentClassName="flex flex-col gap-1.5 pt-1.5">
            {everOpened ? children : null}
          </DisclosureRegion>
        </div>
      ) : null}
    </div>
  );
}
