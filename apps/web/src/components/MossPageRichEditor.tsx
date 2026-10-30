import { useEffect, useRef, useState } from "react";
import { useTheme } from "~/hooks/useTheme";
import { useAppSettings } from "~/appSettings";
import { getAppTypographyScale } from "~/lib/appTypography";
import { resolveWsHttpUrl } from "~/lib/wsHttpUrl";
import { PageRichEditorChannel, type PageRichEditorValue } from "~/lib/pageRichEditorChannel";
import { Button } from "./ui/button";

export function MossPageRichEditor(props: {
  documentKey: string;
  content: string;
  richContent: string | null;
  valueVersion: number;
  readOnly: boolean;
  onChange: (value: PageRichEditorValue) => void;
  onFlushChange: (flush: (() => Promise<boolean>) | null) => void;
  onUnavailableChange: (unavailable: boolean) => void;
}) {
  const { resolvedTheme } = useTheme();
  const { settings } = useAppSettings();
  const fontSize = getAppTypographyScale(settings.chatFontSizePx).chatPx;
  const presentation = useRef({ theme: resolvedTheme, fontSize });
  presentation.current = { theme: resolvedTheme, fontSize };
  const frame = useRef<HTMLIFrameElement | null>(null);
  const latest = useRef(props);
  latest.current = props;
  const [nonce] = useState(() => crypto.randomUUID());
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [src] = useState(() => {
    const url = new URL(resolveWsHttpUrl("/canvas/page-editor.html"), window.location.origin);
    url.searchParams.delete("token");
    url.searchParams.set("moss_page_editor", "1");
    url.searchParams.set("sessionNonce", nonce);
    url.searchParams.set("moss_parent_origin", window.location.origin);
    return url.toString();
  });
  const origin = new URL(src).origin;
  const [channel] = useState(
    () =>
      new PageRichEditorChannel(
        nonce,
        (message) => frame.current?.contentWindow?.postMessage(message, origin),
        (value) => latest.current.onChange(value),
        (isReady) => {
          setReady(isReady);
          if (isReady) setError(null);
        },
        setError,
        (unavailable) => latest.current.onUnavailableChange(unavailable),
      ),
  );
  useEffect(() => {
    const handler = (event: MessageEvent) => {
      if (event.source !== frame.current?.contentWindow || event.origin !== origin) return;
      channel.receive(event.data);
    };
    window.addEventListener("message", handler);
    return () => {
      window.removeEventListener("message", handler);
      channel.reset();
    };
  }, [channel, origin]);
  useEffect(() => {
    const current = latest.current;
    channel.load({
      documentKey: current.documentKey,
      content: current.content,
      richContent: current.richContent,
      readOnly: current.readOnly,
      ...presentation.current,
    });
  }, [channel, props.documentKey, props.valueVersion]);
  useEffect(
    () => channel.setPresentation({ theme: resolvedTheme, fontSize }),
    [channel, resolvedTheme, fontSize],
  );
  useEffect(() => channel.setReadOnly(props.readOnly), [channel, props.readOnly]);
  useEffect(() => {
    props.onFlushChange(channel.flush);
    return () => props.onFlushChange(null);
  }, [channel, props.onFlushChange]);
  useEffect(() => {
    if (ready || error) return;
    const timer = setTimeout(
      () => setError("页面编辑器尚未连接，请重试。已保存内容仍然保留。"),
      15_000,
    );
    return () => clearTimeout(timer);
  }, [ready, error, reload]);

  return (
    <div className="relative flex min-h-80 min-w-0 flex-1 flex-col" data-page-rich-editor>
      {error ? (
        <div role="alert" className="flex items-center gap-3 border-b border-border p-3 text-ui-sm">
          <span className="flex-1">{error}</span>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              if (!ready) {
                channel.reset();
                setError(null);
                setReload((value) => value + 1);
              } else void channel.flush();
            }}
          >
            重试编辑器
          </Button>
        </div>
      ) : null}
      <iframe
        key={reload}
        ref={frame}
        src={src}
        title="页面富文本编辑器"
        className="min-h-80 w-full flex-1 border-0 bg-background"
        onLoad={() => {
          channel.reset();
          channel.hello();
        }}
      />
      {!ready && !error ? (
        <div
          role="status"
          className="absolute inset-0 flex items-center justify-center bg-background text-ui-sm text-muted-foreground"
        >
          正在加载页面编辑器…
        </div>
      ) : null}
    </div>
  );
}
