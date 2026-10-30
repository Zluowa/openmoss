export const DESKTOP_SMOKE_FATAL_PATTERNS = [
  "Cannot find module",
  "MODULE_NOT_FOUND",
  "Refused to execute",
  "Uncaught Error",
  "Uncaught TypeError",
  "Uncaught ReferenceError",
  "icudtl.dat not found in bundle",
  "Renderer process crashed",
  "GPU process isn't usable",
  "[desktop] renderer process gone",
];

export function findDesktopSmokeFailures(output) {
  return DESKTOP_SMOKE_FATAL_PATTERNS.filter((pattern) => output.includes(pattern));
}
