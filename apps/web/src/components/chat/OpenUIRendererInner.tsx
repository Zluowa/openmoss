// FILE: OpenUIRendererInner.tsx
// Purpose: Lazily loaded OpenUI rendering core: the react-lang Renderer, the
//          chat-optimized component library, OpenUI styles, and theme bridging
//          from Moss's resolved theme into OpenUI's ThemeProvider.
// Layer: Chat UI (lazy chunk — loaded on first OpenUI frame)

import { Renderer, type ActionEvent } from "@openuidev/react-lang";
import { ThemeProvider } from "@openuidev/react-ui/ThemeProvider";
import "@openuidev/react-ui/styles/index.css";
import { useMemo, useState } from "react";

import { useTranslation } from "~/localization";
import { OpenUICopyContext } from "~/lib/openui/oiuFollowUp";

import type { OpenUIDirective } from "~/lib/inlineVisualizationDirective";
import { mossOpenUILibrary } from "~/lib/mossOpenUILibrary";
import type { OpenUIFormStateLease } from "~/lib/openUIFormState";
import { validateOpenUIProgram } from "~/lib/openUIValidation";
import { OpenUIFrameFallback } from "./OpenUIFrame";
import { useTheme } from "../../hooks/useTheme";

export default function OpenUIRendererInner(props: {
  readonly directive: OpenUIDirective;
  readonly isStreaming: boolean;
  readonly formState: OpenUIFormStateLease;
  readonly onAction: (event: ActionEvent) => void;
}) {
  const { resolvedTheme } = useTheme();
  const { t } = useTranslation();
  const followUpsHeading = t("chat.visualReply.followUps");
  const copy = useMemo(() => ({ followUpsHeading }), [followUpsHeading]);
  const [initialState] = useState(() => props.formState.read());
  // The renderer silently drops unknown component calls, which would otherwise
  // surface as a blank frame. While streaming, partial programs routinely look
  // invalid, so only hard-check the finished program.
  const unknownComponents = useMemo(
    () =>
      props.isStreaming ? undefined : validateOpenUIProgram(props.directive.code).unknownComponents,
    [props.isStreaming, props.directive.code],
  );
  if (unknownComponents && unknownComponents.length > 0) {
    return (
      <OpenUIFrameFallback directive={props.directive} unknownComponents={unknownComponents} />
    );
  }
  return (
    <ThemeProvider mode={resolvedTheme === "dark" ? "dark" : "light"}>
      <OpenUICopyContext.Provider value={copy}>
        <Renderer
          response={props.directive.code}
          library={mossOpenUILibrary}
          isStreaming={props.isStreaming}
          onAction={props.onAction}
          onStateUpdate={(state) => props.formState.write(state)}
          {...(initialState ? { initialState } : {})}
        />
      </OpenUICopyContext.Provider>
    </ThemeProvider>
  );
}
