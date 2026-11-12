// FILE: usageProjectPaths.test.ts
// Purpose: Session folders map to Moss projects in POSIX and Windows spellings,
// whatever platform runs the test.
// Layer: server usage analytics tests (pure).

import { describe, expect, it } from "vitest";

import {
  makeDirectoryProjectResolver,
  normalizeDirectory,
  type ProjectRoot,
} from "./usageProjectPaths";

const app = { projectId: "project-app", title: "App" };
const api = { projectId: "project-api", title: "API" };

describe("normalizeDirectory", () => {
  it.each([
    ["D:\\Work\\App", "d:\\work\\app"],
    ["d:/work/app/", "d:\\work\\app"],
    ["D:\\Work\\\\App\\\\", "d:\\work\\app"],
    ["D:\\Work\\App\\sub\\..", "d:\\work\\app"],
    ["\\\\?\\D:\\Work\\App", "d:\\work\\app"],
    ["/d/Work/App", "d:\\work\\app"],
    ["D:\\", "d:\\"],
    ["D:", "d:\\"],
    ["\\\\Server\\Share\\App", "\\\\server\\share\\app"],
    ["//server/share/app/", "\\\\server\\share\\app"],
    ["\\\\?\\UNC\\server\\share\\app", "\\\\server\\share\\app"],
  ])("win32 %s", (raw, key) => {
    expect(normalizeDirectory(raw, "win32")?.key).toBe(key);
  });

  it("keeps the case of a Windows path for names", () => {
    expect(normalizeDirectory("d:/Work/App/", "win32")?.path).toBe("D:\\Work\\App");
  });

  it.each(["", "relative\\dir", "\\\\server", "app"])("win32 refuses %j", (raw) => {
    expect(normalizeDirectory(raw, "win32")).toBeNull();
  });

  it.each([
    ["/work/app", "/work/app"],
    ["/work/app/", "/work/app"],
    ["/work//app/sub/..", "/work/app"],
    ["/", "/"],
  ])("posix %s", (raw, key) => {
    expect(normalizeDirectory(raw, "posix")?.key).toBe(key);
  });

  it("compares POSIX paths with case", () => {
    expect(normalizeDirectory("/Work/App", "posix")?.key).toBe("/Work/App");
    expect(normalizeDirectory("relative/dir", "posix")).toBeNull();
  });
});

describe("makeDirectoryProjectResolver", () => {
  it("puts Windows sessions under their project whatever the spelling", () => {
    const roots: ProjectRoot[] = [
      { path: "D:\\Work\\App", project: app },
      { path: "D:\\Work\\App\\services\\api\\", project: api },
      { path: "C:\\Users\\me", project: null },
    ];
    const resolve = makeDirectoryProjectResolver(roots, "win32");
    expect(resolve("D:\\Work\\App")).toEqual(app);
    expect(resolve("d:/work/app/sub/")).toEqual(app);
    expect(resolve("D:\\WORK\\APP\\.claude\\worktrees\\x")).toEqual(app);
    // Nested roots: the deepest one wins.
    expect(resolve("D:\\Work\\App\\Services\\API\\src")).toEqual(api);
    // A sibling folder that shares the prefix is not inside.
    expect(resolve("D:\\Work\\AppTwo")).toEqual({ projectId: "folder:apptwo", title: "AppTwo" });
    // A chat container claims only its own folder.
    expect(resolve("c:\\users\\me")).toBeNull();
    expect(resolve("C:\\Users\\me\\code\\tool")).toEqual({
      projectId: "folder:tool",
      title: "tool",
    });
  });

  it("names an unknown Windows worktree after its repo, one id across cases", () => {
    const resolve = makeDirectoryProjectResolver([], "win32");
    expect(resolve("E:\\Elsewhere\\Tool\\.claude\\worktrees\\feature-x")).toEqual({
      projectId: "folder:tool",
      title: "Tool",
    });
    expect(resolve("e:/elsewhere/tool")?.projectId).toBe("folder:tool");
  });

  it("handles UNC folders and roots without crashing", () => {
    const resolve = makeDirectoryProjectResolver(
      [{ path: "\\\\server\\share\\app", project: app }],
      "win32",
    );
    expect(resolve("//SERVER/share/app/sub")).toEqual(app);
    expect(resolve("\\\\server\\share")).toEqual({ projectId: "folder:share", title: "share" });
    expect(resolve("\\\\server")).toBeNull();
    expect(resolve("D:\\")).toBeNull();
    expect(resolve("not a path")).toBeNull();
  });

  it("puts POSIX sessions under their project, with case", () => {
    const roots: ProjectRoot[] = [
      { path: "/work/app/", project: app },
      { path: "/work/app/services/api", project: api },
      { path: "/home/me", project: null },
    ];
    const resolve = makeDirectoryProjectResolver(roots, "posix");
    expect(resolve("/work/app/sub")).toEqual(app);
    expect(resolve("/work/app/services/api/src")).toEqual(api);
    expect(resolve("/work/appendix")).toEqual({ projectId: "folder:appendix", title: "appendix" });
    expect(resolve("/Work/App/sub")).toEqual({ projectId: "folder:sub", title: "sub" });
    expect(resolve("/home/me")).toBeNull();
    expect(resolve("/elsewhere/tool/.claude/worktrees/feature-x")).toEqual({
      projectId: "folder:tool",
      title: "tool",
    });
    // Windows spellings are not POSIX paths.
    expect(resolve("D:\\Work\\App")).toBeNull();
  });
});
