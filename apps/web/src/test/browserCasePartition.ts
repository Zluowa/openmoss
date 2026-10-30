export interface BrowserCasePartition {
  index: number;
  count: number;
}

export function parseBrowserCasePartition(value: string | undefined): BrowserCasePartition {
  if (value === undefined) return { index: 1, count: 1 };
  const match = /^(\d+)\/(\d+)$/.exec(value);
  const index = Number(match?.[1]);
  const count = Number(match?.[2]);
  if (!Number.isSafeInteger(index) || !Number.isSafeInteger(count) || index < 1 || index > count) {
    throw new Error("MOSS_BROWSER_CASE_PARTITION must be an index/count pair, such as 1/4.");
  }
  return { index, count };
}

/** Hash expanded names, so parameterized and newly added cases get one owner. */
export function browserCasePartitionIndex(fullName: string, count: number): number {
  let hash = 2_166_136_261;
  for (let index = 0; index < fullName.length; index += 1) {
    hash = Math.imul(hash ^ fullName.charCodeAt(index), 16_777_619);
  }
  return ((hash >>> 0) % count) + 1;
}

interface NamedTask {
  name: string;
  suite?: NamedTask | undefined;
  file?: NamedTask | undefined;
}

/** Leave filesystem paths out of the assignment so local and CI names agree. */
export function browserCaseFullName(task: NamedTask): string {
  const names: string[] = [];
  for (
    let current: NamedTask | undefined = task;
    current && current !== task.file;
    current = current.suite
  ) {
    names.unshift(current.name);
  }
  return names.join(" ");
}
