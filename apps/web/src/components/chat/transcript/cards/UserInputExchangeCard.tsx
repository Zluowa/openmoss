// FILE: UserInputExchangeCard.tsx
// Purpose: An answered agent question in the transcript: question and answer bubbles.
//          Moved out of MessagesTimeline onto the card registry.
// Layer: Chat transcript UI
// Exports: UserInputExchange

import type { CSSProperties } from "react";

import { cn } from "~/lib/utils";
import { MUTED_LABEL_TEXT_CLASS_NAME } from "~/surfaceStyles";
import type { WorkLogUserInputExchangeItem } from "../../../../workLog";
import { USER_INPUT_EXCHANGE_BUBBLE_CLASS_NAME } from "../../chatTypography";

// An answered agent question: the question as a left bubble and the submitted
// answer as a right bubble, both dashed so they read as part of the agent's run.
export function UserInputExchange(props: {
  items: ReadonlyArray<WorkLogUserInputExchangeItem>;
  chatTypographyStyle: CSSProperties;
  answerTypographyStyle: CSSProperties;
  labelStyle: CSSProperties;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-2 py-0.5">
      {props.items.map((item) => (
        <div key={item.id} className="flex min-w-0 flex-col gap-2">
          <div className={cn(USER_INPUT_EXCHANGE_BUBBLE_CLASS_NAME, "self-start")}>
            <p className={MUTED_LABEL_TEXT_CLASS_NAME} style={props.labelStyle}>
              {item.header}
            </p>
            <p className="whitespace-pre-wrap break-words" style={props.chatTypographyStyle}>
              {item.question}
            </p>
            {item.options.length > 0 ? (
              <p className="text-muted-foreground" style={props.labelStyle}>
                {item.options.join(" · ")}
              </p>
            ) : null}
          </div>
          <div className={cn(USER_INPUT_EXCHANGE_BUBBLE_CLASS_NAME, "self-end")}>
            <p className={MUTED_LABEL_TEXT_CLASS_NAME} style={props.labelStyle}>
              Answer
            </p>
            <p className="whitespace-pre-wrap break-words" style={props.answerTypographyStyle}>
              {item.answer ?? "No answer"}
            </p>
          </div>
        </div>
      ))}
    </div>
  );
}
