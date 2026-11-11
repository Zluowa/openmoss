// FILE: ioLimit.ts
// Purpose: Cap how many filesystem calls one import source has in flight. The probe reads
//          every agent's folders at once; on a cold disk (or a USB hard disk) one call after
//          another is what made a single source take 15 s, but an unbounded burst would let
//          one large folder crowd out the others.
// Layer: Server import helper

/** Runs filesystem calls with at most `limit` in flight. Wrap single calls, never a walk. */
export type ImportIoLimiter = <T>(call: () => Promise<T>) => Promise<T>;

/** In-flight filesystem calls per import source. */
export const IMPORT_SOURCE_IO_CONCURRENCY = 8;

export function createImportIoLimiter(limit = IMPORT_SOURCE_IO_CONCURRENCY): ImportIoLimiter {
  const max = Math.max(1, Math.floor(limit));
  let active = 0;
  const waiting: Array<() => void> = [];
  const release = () => {
    active -= 1;
    waiting.shift()?.();
  };
  return async <T>(call: () => Promise<T>): Promise<T> => {
    if (active >= max) await new Promise<void>((resolve) => waiting.push(resolve));
    active += 1;
    try {
      return await call();
    } finally {
      release();
    }
  };
}
