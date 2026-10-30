export const THREAD_HISTORY_PREFETCH_DISTANCE_PX = 800;

export function shouldPrefetchThreadHistory(scrollTop: number): boolean {
  return Number.isFinite(scrollTop) && scrollTop <= THREAD_HISTORY_PREFETCH_DISTANCE_PX;
}
