// Vitest setup file added by the test-quarantine plugin. It runs in Node and in the browser,
// so it imports nothing but Vitest. Setup-file hooks run before the test file's own hooks.
import { beforeEach, inject } from "vitest";

import { PROVIDE_KEY, normalisePath, type QuarantineContext } from "./context";
import { nameCovers } from "./quarantine";

interface NamedTask {
  readonly name: string;
  readonly suite?: NamedTask | undefined;
  readonly file?: { readonly filepath?: string } & NamedTask;
}

function chainOf(task: NamedTask): string {
  const names: string[] = [];
  for (
    let current: NamedTask | undefined = task;
    current && current !== task.file;
    current = current.suite
  ) {
    names.unshift(current.name);
  }
  return names.join(" > ");
}

const quarantine: QuarantineContext = inject(PROVIDE_KEY);

beforeEach((context) => {
  if (quarantine.mode === "off") return;
  const task = context.task as unknown as NamedTask;
  const file = normalisePath(task.file?.filepath ?? "", quarantine.lowerCasePaths);
  const whole = quarantine.wholeFiles.includes(file);
  const tests = quarantine.tests.filter((entry) => entry.file === file);
  if (quarantine.mode === "on") {
    if (whole) context.skip(`quarantined: ${file}`);
    const chain = chainOf(task);
    const match = tests.find((entry) => nameCovers(entry.name, chain));
    if (match) context.skip(`quarantined: ${match.id}`);
    return;
  }
  // only: a whole-file entry runs everything; otherwise only the covered tests run.
  if (whole || tests.length === 0) return;
  const chain = chainOf(task);
  if (!tests.some((entry) => nameCovers(entry.name, chain))) context.skip("not quarantined");
});
