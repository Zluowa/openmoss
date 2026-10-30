export function mediaDuration(seconds: number): number {
  return Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
}

export function formatAudioTime(seconds: number): string {
  const total = Math.floor(mediaDuration(seconds));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}
