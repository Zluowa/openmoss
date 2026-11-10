// Shared presentation only. Each transport owns its frame and authorization lifecycle.
import type { Ref } from "react";
import { useTranslation } from "~/localization";
import { readonlyAppItemCopy } from "./readonlyAppItemCopy";
import type { ReadonlyAppItemFrameStatus } from "./readonlyAppItemFrameController";

export function ReadonlyAppItemFrameSurface(props: {
  readonly frameRef: Ref<HTMLIFrameElement>;
  readonly title: string;
  readonly audience: "owner" | "guest" | "template";
  readonly status: ReadonlyAppItemFrameStatus;
  readonly height?: number;
  readonly className?: string;
  readonly name?: string;
}) {
  const { locale } = useTranslation();
  const copy = readonlyAppItemCopy(locale);
  return (
    <div
      className="relative h-full min-h-0 w-full"
      data-readonly-app-item={props.audience}
      data-frame-status={props.status}
    >
      <iframe
        ref={props.frameRef}
        name={props.name}
        title={props.title}
        sandbox="allow-scripts allow-forms"
        referrerPolicy="no-referrer"
        tabIndex={props.audience === "template" ? -1 : undefined}
        className={props.className ?? "h-full w-full border-0 bg-background"}
        style={props.height ? { height: props.height } : undefined}
      />
      {props.status !== "ready" ? (
        <p
          role="status"
          className="absolute inset-0 grid place-items-center bg-background px-4 text-center text-ui-sm text-muted-foreground"
        >
          {props.status === "loading"
            ? copy.loading
            : props.status === "expired"
              ? copy.expired
              : props.status === "timeout"
                ? copy.timeout
                : props.status === "unavailable"
                  ? copy.accessUnavailable
                  : copy.invalid}
        </p>
      ) : null}
    </div>
  );
}
