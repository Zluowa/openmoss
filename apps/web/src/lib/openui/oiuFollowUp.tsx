// FILE: oiuFollowUp.tsx
// Purpose: Moss's FollowUpBlock renderer: the stock block's markup and classes, with the heading
//          in the reader's language instead of the package's fixed English "Related Queries".
// Layer: Chat UI support (renderer for mossOpenUILibrary.tsx; importable outside the browser, so
//        the copy arrives through OpenUICopyContext from the lazy renderer chunk, which owns
//        localization)

import { useTriggerAction } from "@openuidev/react-lang";
import { createContext, useContext } from "react";

export interface OpenUICopy {
  readonly followUpsHeading: string;
}

export const OpenUICopyContext = createContext<OpenUICopy>({
  followUpsHeading: "Related questions",
});

interface FollowUpItemNode {
  readonly props?: { readonly text?: unknown } | undefined;
}

export function FollowUpBlockView({
  props,
}: {
  readonly props: { readonly items?: ReadonlyArray<FollowUpItemNode | null> | undefined };
}) {
  const triggerAction = useTriggerAction();
  const { followUpsHeading } = useContext(OpenUICopyContext);
  // An item is its text; the same text twice gets its occurrence number.
  const occurrences = new Map<string, number>();
  return (
    <div className="openui-follow-up-block">
      <div className="openui-follow-up-block__header">{followUpsHeading}</div>
      {(props.items ?? []).map((item) => {
        const text = String(item?.props?.text ?? "");
        const occurrence = (occurrences.get(text) ?? 0) + 1;
        occurrences.set(text, occurrence);
        return (
          <button
            key={`${occurrence}:${text}`}
            type="button"
            className="openui-follow-up-item"
            onClick={() => triggerAction(text)}
          >
            {text ? <span className="openui-follow-up-item-text">{text}</span> : null}
          </button>
        );
      })}
    </div>
  );
}
