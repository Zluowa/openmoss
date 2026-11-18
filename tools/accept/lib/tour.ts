// FILE: tour.ts
// Purpose: The acceptance kit's tour format: a named list of steps a person would take in the
//          Moss window, with `report` steps that call Moss's own self-report tools
//          (apps/web/src/lib/selfReport) and decide pass or fail from their answers.
// Layer: tools/accept (no Electron, no browser: parsing and verdicts only)

export const KNOWN_SELF_REPORT_VERSIONS = [1] as const;

export const SELF_REPORT_TOOL_NAMES = [
  "screen_report",
  "layout_report",
  "screenshot",
  "console_report",
] as const;
export type SelfReportToolName = (typeof SELF_REPORT_TOOL_NAMES)[number];

export interface Size {
  readonly width: number;
  readonly height: number;
}

export type TourStep =
  | { readonly do: "click"; readonly selector: string }
  | { readonly do: "press"; readonly key: string }
  | { readonly do: "type"; readonly selector: string; readonly text: string }
  | { readonly do: "wait"; readonly ms: number }
  | { readonly do: "waitFor"; readonly selector: string; readonly timeoutMs?: number }
  | {
      readonly do: "report";
      readonly label: string;
      readonly tools: readonly SelfReportToolName[];
      readonly sizes?: "standard" | readonly Size[];
      /** Layout findings tolerated at this step (default 0). */
      readonly allowLayoutFindings?: number;
    };

export interface Tour {
  readonly name: string;
  readonly description?: string;
  /** Console errors tolerated over the whole tour (default 0). Warnings never fail a tour. */
  readonly allowConsoleErrors?: number;
  readonly steps: readonly TourStep[];
}

export class TourError extends Error {}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function str(o: Record<string, unknown>, key: string, where: string): string {
  const v = o[key];
  if (typeof v !== "string" || v.trim() === "")
    throw new TourError(`${where}: "${key}" must be a non-empty string`);
  return v;
}

function count(o: Record<string, unknown>, key: string, where: string): number | undefined {
  const v = o[key];
  if (v === undefined) return undefined;
  if (typeof v !== "number" || !Number.isInteger(v) || v < 0)
    throw new TourError(`${where}: "${key}" must be a whole number of 0 or more`);
  return v;
}

function sizes(v: unknown, where: string): "standard" | Size[] | undefined {
  if (v === undefined || v === "standard") return v;
  if (!Array.isArray(v) || v.length === 0)
    throw new TourError(`${where}: "sizes" must be "standard" or a list`);
  return v.map((s, i) => {
    if (!isRecord(s) || typeof s.width !== "number" || typeof s.height !== "number")
      throw new TourError(`${where}: sizes[${i}] needs a numeric width and height`);
    if (s.width < 200 || s.height < 200 || s.width > 7680 || s.height > 4320)
      throw new TourError(`${where}: sizes[${i}] must be between 200x200 and 7680x4320`);
    return { width: s.width, height: s.height };
  });
}

function step(raw: unknown, index: number): TourStep {
  const where = `step ${index + 1}`;
  if (!isRecord(raw)) throw new TourError(`${where}: must be an object`);
  switch (raw.do) {
    case "click":
      return { do: "click", selector: str(raw, "selector", where) };
    case "press":
      return { do: "press", key: str(raw, "key", where) };
    case "type":
      return { do: "type", selector: str(raw, "selector", where), text: str(raw, "text", where) };
    case "wait": {
      const ms = count(raw, "ms", where);
      if (ms === undefined || ms > 60_000) throw new TourError(`${where}: "ms" must be 0-60000`);
      return { do: "wait", ms };
    }
    case "waitFor": {
      const timeoutMs = count(raw, "timeoutMs", where);
      return {
        do: "waitFor",
        selector: str(raw, "selector", where),
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
      };
    }
    case "report": {
      const tools = raw.tools;
      if (!Array.isArray(tools) || tools.length === 0)
        throw new TourError(`${where}: "tools" must list at least one self-report tool`);
      for (const t of tools)
        if (!SELF_REPORT_TOOL_NAMES.includes(t as SelfReportToolName))
          throw new TourError(`${where}: unknown tool ${JSON.stringify(t)}`);
      const allow = count(raw, "allowLayoutFindings", where);
      const s = sizes(raw.sizes, where);
      return {
        do: "report",
        label: str(raw, "label", where),
        tools: tools as SelfReportToolName[],
        ...(s === undefined ? {} : { sizes: s }),
        ...(allow === undefined ? {} : { allowLayoutFindings: allow }),
      };
    }
    default:
      throw new TourError(`${where}: unknown step ${JSON.stringify(raw.do)}`);
  }
}

export function parseTour(raw: unknown): Tour {
  if (!isRecord(raw)) throw new TourError("a tour must be a JSON object");
  const steps = raw.steps;
  if (!Array.isArray(steps) || steps.length === 0) throw new TourError('a tour needs "steps"');
  const parsed = steps.map(step);
  if (!parsed.some((s) => s.do === "report"))
    throw new TourError("a tour needs at least one report step, or it proves nothing");
  const labels = parsed.flatMap((s) => (s.do === "report" ? [s.label] : []));
  const dup = labels.find((l, i) => labels.indexOf(l) !== i);
  if (dup) throw new TourError(`report label ${JSON.stringify(dup)} is used twice`);
  const allow = count(raw, "allowConsoleErrors", "tour");
  return {
    name: str(raw, "name", "tour"),
    ...(typeof raw.description === "string" ? { description: raw.description } : {}),
    ...(allow === undefined ? {} : { allowConsoleErrors: allow }),
    steps: parsed,
  };
}

// ---------------------------------------------------------------------------------------------
// Verdicts

export interface ReportAnswers {
  readonly label: string;
  readonly answers: Partial<Record<SelfReportToolName, unknown>>;
  readonly allowLayoutFindings: number;
}

export interface Problem {
  readonly step: string;
  readonly kind: "layout" | "console" | "tool-error" | "screenshot" | "step-failed" | "on-screen";
  readonly detail: string;
}

function asList(v: unknown, key: string): unknown[] {
  return isRecord(v) && Array.isArray(v[key]) ? (v[key] as unknown[]) : [];
}

/** Problems in one report step's answers (console errors are summed over the tour separately). */
export function reportProblems(report: ReportAnswers): Problem[] {
  const problems: Problem[] = [];
  for (const [tool, answer] of Object.entries(report.answers)) {
    if (isRecord(answer) && typeof answer.error === "string")
      problems.push({ step: report.label, kind: "tool-error", detail: `${tool}: ${answer.error}` });
    // #704: every answer's window says whether main measured it off every display.
    const win = isRecord(answer) && isRecord(answer.window) ? answer.window : undefined;
    if (win && win.offscreen === false)
      problems.push({
        step: report.label,
        kind: "on-screen",
        detail: `${tool}: Moss reports its window on a display at ${String(win.left)},${String(win.top)}`,
      });
  }
  const findings = asList(report.answers.layout_report, "findings");
  if (findings.length > report.allowLayoutFindings) {
    const first = findings
      .slice(0, 3)
      .map((f) => (isRecord(f) ? `${String(f.kind)} ${String(f.selector)}` : String(f)))
      .join("; ");
    problems.push({
      step: report.label,
      kind: "layout",
      detail: `${findings.length} layout findings (allowed ${report.allowLayoutFindings}): ${first}`,
    });
  }
  if ("screenshot" in report.answers && asList(report.answers.screenshot, "files").length === 0)
    problems.push({
      step: report.label,
      kind: "screenshot",
      detail: "no screenshot file was written",
    });
  return problems;
}

/** Console errors (not warnings) across all console_report answers. */
export function consoleErrors(reports: readonly ReportAnswers[]): { step: string; text: string }[] {
  return reports.flatMap((r) =>
    asList(r.answers.console_report, "entries")
      .filter((e) => isRecord(e) && e.level === "error")
      .map((e) => ({
        step: r.label,
        text: String((e as Record<string, unknown>).text).slice(0, 300),
      })),
  );
}

export function verdict(
  tour: Tour,
  reports: readonly ReportAnswers[],
  stepFailures: readonly Problem[],
): { pass: boolean; problems: Problem[] } {
  const problems = [...stepFailures, ...reports.flatMap(reportProblems)];
  const errors = consoleErrors(reports);
  const allowed = tour.allowConsoleErrors ?? 0;
  if (errors.length > allowed) {
    problems.push({
      step: errors[0]!.step,
      kind: "console",
      detail: `${errors.length} console errors (allowed ${allowed}); first: ${errors[0]!.text}`,
    });
  }
  return { pass: problems.length === 0, problems };
}
