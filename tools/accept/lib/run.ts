// FILE: run.ts
// Purpose: Walk a tour in a launched Moss window: act like a person (click, press, type, wait),
//          and at each report step call Moss's self-report tools and keep their answers, the
//          screenshots and a verdict in the run folder.
// Layer: tools/accept

import fs from "node:fs";
import path from "node:path";

import type { Page } from "playwright";

import {
  verdict,
  type Problem,
  type ReportAnswers,
  type SelfReportToolName,
  type Tour,
  type TourStep,
} from "./tour.ts";

/** The self-report tools answer within 10 s; the kit allows 15 (agreed with moss-agent-runtime). */
export const TOOL_TIMEOUT_MS = 15_000;

export type ToolCaller = (
  name: SelfReportToolName,
  input: Record<string, unknown>,
) => Promise<unknown>;

export function pageCaller(page: Page): ToolCaller {
  return async (name, input) => {
    const call = page.evaluate(
      ([n, i]) =>
        (
          window as {
            mossSelfReport?: { call: (name: string, input?: unknown) => Promise<unknown> };
          }
        ).mossSelfReport!.call(n, i),
      [name, input] as const,
    );
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`${name} took longer than ${TOOL_TIMEOUT_MS} ms`)),
        TOOL_TIMEOUT_MS,
      );
    });
    try {
      return await Promise.race([call, timeout]);
    } finally {
      clearTimeout(timer);
    }
  };
}

export interface Actor {
  click(selector: string): Promise<void>;
  press(key: string): Promise<void>;
  type(selector: string, text: string): Promise<void>;
  waitFor(selector: string, timeoutMs: number): Promise<void>;
}

export function pageActor(page: Page): Actor {
  return {
    click: (selector) => page.locator(selector).first().click({ timeout: 10_000 }),
    press: (key) => page.keyboard.press(key),
    type: (selector, text) => page.locator(selector).first().fill(text, { timeout: 10_000 }),
    waitFor: (selector, timeoutMs) =>
      page.locator(selector).first().waitFor({ state: "visible", timeout: timeoutMs }),
  };
}

export interface TourResult {
  readonly tour: string;
  readonly runId: string;
  readonly pass: boolean;
  readonly problems: Problem[];
  readonly reports: ReportAnswers[];
  readonly ms: number;
}

function inMotion(answer: unknown): number {
  const n = (answer as { inMotion?: unknown } | null)?.inMotion;
  return typeof n === "number" ? n : 0;
}

function slug(label: string): string {
  return (
    label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "step"
  );
}

async function act(step: Exclude<TourStep, { do: "report" }>, actor: Actor): Promise<void> {
  switch (step.do) {
    case "click":
      return actor.click(step.selector);
    case "press":
      return actor.press(step.key);
    case "type":
      return actor.type(step.selector, step.text);
    case "wait":
      return new Promise((r) => setTimeout(r, step.ms));
    case "waitFor":
      return actor.waitFor(step.selector, step.timeoutMs ?? 15_000);
  }
}

export async function runTour(
  tour: Tour,
  deps: {
    call: ToolCaller;
    actor: Actor;
    outDir: string;
    runId: string;
    log?: (line: string) => void;
    /** Throws when the window is where the owner can see it; checked before the first step and around every screenshot. */
    guard?: (when: string) => void;
  },
): Promise<TourResult> {
  const log = deps.log ?? (() => {});
  const started = Date.now();
  const reports: ReportAnswers[] = [];
  const failures: Problem[] = [];
  // console_report returns what was logged since its last call, so errors logged during start
  // show up in the first report step that asks for it.
  const guard = deps.guard ?? (() => {});
  try {
    guard("before the first step");
  } catch (error) {
    failures.push({
      step: "start",
      kind: "step-failed",
      detail: error instanceof Error ? error.message : String(error),
    });
  }
  for (const [index, step] of (failures.length ? [] : tour.steps).entries()) {
    const name = step.do === "report" ? step.label : `step ${index + 1} (${step.do})`;
    try {
      if (step.do !== "report") {
        await act(step, deps.actor);
        continue;
      }
      const dir = path.join(
        deps.outDir,
        `${String(index + 1).padStart(2, "0")}-${slug(step.label)}`,
      );
      fs.mkdirSync(dir, { recursive: true });
      const answers: Partial<Record<SelfReportToolName, unknown>> = {};
      for (const tool of step.tools) {
        const input: Record<string, unknown> = { runId: deps.runId };
        if (tool === "screenshot") {
          input.dir = dir;
          if (step.sizes) input.sizes = step.sizes;
        }
        // The screenshot tool resizes the window and restores it: check where it is around it.
        if (tool === "screenshot") guard(`before the screenshot at "${step.label}"`);
        try {
          answers[tool] = await deps.call(tool, input);
          // layout_report leaves out findings on elements still in a transition and counts them in
          // `inMotion` (#700): the screen was not settled, so ask once more.
          if (tool === "layout_report" && inMotion(answers[tool]) > 0)
            answers[tool] = await deps.call(tool, input);
        } catch (error) {
          answers[tool] = { error: error instanceof Error ? error.message : String(error) };
        }
        if (tool === "screenshot") guard(`after the screenshot at "${step.label}"`);
        fs.writeFileSync(
          path.join(dir, `${tool}.json`),
          `${JSON.stringify(answers[tool], null, 2)}\n`,
        );
      }
      reports.push({
        label: step.label,
        answers,
        allowLayoutFindings: step.allowLayoutFindings ?? 0,
      });
      log(`report "${step.label}": ${step.tools.join(", ")}`);
    } catch (error) {
      failures.push({
        step: name,
        kind: "step-failed",
        detail: error instanceof Error ? error.message.split("\n")[0]! : String(error),
      });
      log(`${name} failed; the tour stops here`);
      break;
    }
  }
  const { pass, problems } = verdict(tour, reports, failures);
  const result: TourResult = {
    tour: tour.name,
    runId: deps.runId,
    pass,
    problems,
    reports,
    ms: Date.now() - started,
  };
  fs.writeFileSync(
    path.join(deps.outDir, "result.json"),
    `${JSON.stringify({ ...result, reports: reports.map((r) => r.label) }, null, 2)}\n`,
  );
  return result;
}
