import { useRef, useState } from "react";

import { basenameOfPath } from "~/file-icons";
import { DownloadIcon, Loader2Icon, PauseIcon, PlayIcon } from "~/lib/icons";
import { buildLocalImageUrl } from "~/lib/localImageUrls";

import { Button } from "./ui/button";
import { formatAudioTime, mediaDuration } from "./preview/audioTime";

export interface LocalMediaPreviewProps {
  filePath: string;
  cwd: string | null | undefined;
  previewGrant?: string | null;
  cacheKey?: string | number;
  kind: "audio" | "video";
  onPreviewReady?: () => void;
  onPreviewError?: () => void;
}

export function LocalMediaPreview(props: LocalMediaPreviewProps) {
  const src = buildLocalImageUrl({
    src: props.filePath,
    cwd: props.cwd ?? undefined,
    grant: props.previewGrant,
    cacheKey: props.cacheKey,
  });
  const downloadUrl = buildLocalImageUrl({
    src: props.filePath,
    cwd: props.cwd ?? undefined,
    grant: props.previewGrant,
    download: true,
  });
  // Dispose the old media element and playback state together on reload.
  return (
    <MediaPlayer key={`${props.kind}:${src}`} {...props} src={src} downloadUrl={downloadUrl} />
  );
}

function MediaPlayer({
  src,
  downloadUrl,
  ...props
}: LocalMediaPreviewProps & { src: string; downloadUrl: string }) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const readyRef = useRef(false);
  const [status, setStatus] = useState<"loading" | "ready" | "unavailable">("loading");
  const [duration, setDuration] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const fileName = basenameOfPath(props.filePath);
  const extension = fileName.match(/\.([a-z0-9]+)$/i)?.[1]?.toUpperCase();
  const ready = () => {
    setStatus("ready");
    if (!readyRef.current) {
      readyRef.current = true;
      props.onPreviewReady?.();
    }
  };
  const fail = () => {
    setStatus("unavailable");
    setPlaying(false);
    props.onPreviewError?.();
  };

  if (props.kind === "video") {
    return (
      <div
        className="flex h-full min-h-40 items-center justify-center overflow-auto p-6"
        data-media-preview="video"
      >
        {status === "unavailable" ? (
          <div className="flex flex-col items-center gap-3 text-ui-lg text-muted-foreground">
            <p role="status">Video unavailable</p>
            <a
              className="inline-flex items-center gap-1.5 text-ui-sm hover:underline"
              href={downloadUrl}
              download={fileName}
            >
              <DownloadIcon className="size-4" aria-hidden="true" />
              Download {fileName}
            </a>
          </div>
        ) : (
          <video
            className="my-3 block h-auto max-h-[min(48vh,32rem)] max-w-[min(100%,44rem)] rounded-md object-contain shadow-md"
            src={src}
            title={fileName}
            aria-label={fileName}
            controls
            preload="metadata"
            onLoadedMetadata={ready}
            onCanPlay={ready}
            onError={fail}
          />
        )}
      </div>
    );
  }

  return (
    <div
      className="flex h-full min-h-40 items-center justify-center overflow-auto p-6"
      data-media-preview="audio"
    >
      <div className="my-3 flex w-full max-w-lg flex-col overflow-hidden rounded-lg bg-surface-elevated-secondary/50 font-sans text-default [--thread-resource-card-row-padding-x:0.75rem] electron:elevation-stroke extension:border extension:border-default extension:bg-background-primary-soft/50 extension:shadow-sm">
        <div className="flex min-w-0 items-center gap-2.5 p-1.5 text-start">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-surface-secondary/92">
            <svg
              className="size-6 text-[#3F63D6] dark:text-[#8DB0F5]"
              viewBox="0 0 24 24"
              fill="currentColor"
              aria-hidden="true"
            >
              <rect x="2.2" y="9.5" width="1.6" height="5" rx="0.8" />
              <rect x="5.2" y="7" width="1.6" height="10" rx="0.8" />
              <rect x="8.2" y="4.5" width="1.6" height="15" rx="0.8" />
              <rect x="11.2" y="8" width="1.6" height="8" rx="0.8" />
              <rect x="14.2" y="3" width="1.6" height="18" rx="0.8" />
              <rect x="17.2" y="6.5" width="1.6" height="11" rx="0.8" />
              <rect x="20.2" y="9" width="1.6" height="6" rx="0.8" />
            </svg>
          </span>
          <div className="min-w-0 flex-1">
            <div className="truncate text-size-chat font-medium" title={fileName}>
              {fileName}
            </div>
            <div className="truncate text-size-chat-sm text-secondary" role="status">
              {status === "loading"
                ? "Loading audio…"
                : status === "unavailable"
                  ? "Audio unavailable"
                  : extension
                    ? `${extension} audio`
                    : "Audio"}
            </div>
          </div>
          <span className="flex shrink-0 items-center gap-1">
            {status === "loading" ? (
              <Loader2Icon className="size-4 animate-spin" aria-label="Loading audio" />
            ) : status === "ready" ? (
              <Button
                variant="secondary"
                size="icon-sm"
                aria-label={`${playing ? "Pause" : "Play"} ${fileName}`}
                onClick={() => {
                  const audio = audioRef.current;
                  if (!audio) return;
                  if (audio.paused) void audio.play().catch(() => setPlaying(false));
                  else audio.pause();
                }}
              >
                {playing ? (
                  <PauseIcon className="size-4" aria-hidden="true" />
                ) : (
                  <PlayIcon className="size-4" aria-hidden="true" />
                )}
              </Button>
            ) : null}
            <a
              className="inline-flex size-8 items-center justify-center rounded-lg text-muted-foreground hover:bg-foreground/5 hover:text-foreground"
              href={downloadUrl}
              download={fileName}
              aria-label={`Download ${fileName}`}
              title={`Download ${fileName}`}
            >
              <DownloadIcon className="size-4" aria-hidden="true" />
            </a>
          </span>
        </div>
        {status === "ready" ? (
          <div className="flex items-center gap-2 border-t border-border px-3 py-2">
            <input
              type="range"
              className="h-5 min-w-0 flex-1 cursor-pointer accent-foreground disabled:cursor-default disabled:opacity-40"
              aria-label={`Seek in ${fileName}`}
              disabled={duration <= 0}
              min={0}
              max={duration > 0 ? duration : 1}
              step={0.1}
              value={Math.min(currentTime, duration > 0 ? duration : 1)}
              onChange={(event) => {
                const audio = audioRef.current;
                if (!audio) return;
                audio.currentTime = event.currentTarget.valueAsNumber;
                setCurrentTime(audio.currentTime);
              }}
            />
            <span className="shrink-0 text-size-chat-sm text-secondary tabular-nums">
              {formatAudioTime(currentTime)} / {formatAudioTime(duration)}
            </span>
          </div>
        ) : null}
        {status !== "unavailable" ? (
          <audio
            ref={audioRef}
            className="hidden"
            src={src}
            title={fileName}
            aria-label={fileName}
            controls
            preload="metadata"
            onLoadedMetadata={(event) => {
              setDuration(mediaDuration(event.currentTarget.duration));
              ready();
            }}
            onDurationChange={(event) => setDuration(mediaDuration(event.currentTarget.duration))}
            onCanPlay={ready}
            onError={fail}
            onEnded={() => setPlaying(false)}
            onPause={() => setPlaying(false)}
            onPlay={() => setPlaying(true)}
            onTimeUpdate={(event) => setCurrentTime(mediaDuration(event.currentTarget.currentTime))}
          />
        ) : null}
      </div>
    </div>
  );
}
