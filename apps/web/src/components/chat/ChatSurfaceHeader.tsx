import type { ReactNode } from "react";

export function ChatSurfaceHeader(props: {
  readonly hidden?: boolean;
  readonly className?: string;
  readonly children: ReactNode;
}) {
  if (props.hidden) return null;
  // `data-chat-header` is a stable hook for theme CSS (THEME_CSS_HOOKS in @moss/shared/themeCss).
  return (
    <header className={props.className} data-chat-header="">
      {props.children}
    </header>
  );
}
