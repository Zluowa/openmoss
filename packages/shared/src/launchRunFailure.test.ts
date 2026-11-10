import { describe, expect, it } from "vitest";

import { classifyLaunchRunFailure, commandProgram, launchProgramProduct } from "./launchRunFailure";

describe("commandProgram", () => {
  it("reads the program a command line starts with", () => {
    expect(commandProgram("python -m http.server 8123")).toBe("python");
    expect(commandProgram("npm run dev")).toBe("npm");
    expect(commandProgram("& 'C:\\Program Files\\nodejs\\node.exe' server.js")).toBe(
      "C:\\Program Files\\nodejs\\node.exe",
    );
    expect(commandProgram('"C:\\Tools\\hugo.exe" serve')).toBe("C:\\Tools\\hugo.exe");
    expect(commandProgram("PORT=3000 node server.js")).toBe("node");
    expect(commandProgram("   ")).toBeNull();
  });
});

describe("launchProgramProduct", () => {
  it("names what to install for a missing program", () => {
    expect(launchProgramProduct("python")).toBe("Python");
    expect(launchProgramProduct("npx.cmd")).toBe("Node.js");
    expect(launchProgramProduct("C:\\x\\bunx.exe")).toBe("Bun");
    expect(launchProgramProduct("frobnicate")).toBeNull();
  });
});

describe("classifyLaunchRunFailure", () => {
  it("finds the missing program in PowerShell's error, in English and Chinese", () => {
    const english =
      "python : The term 'python' is not recognized as the name of a cmdlet, function, script file, or operable program.\r\n" +
      "    + FullyQualifiedErrorId : CommandNotFoundException\r\n";
    expect(classifyLaunchRunFailure({ output: english })).toEqual({
      kind: "program-missing",
      program: "python",
    });
    const chinese =
      "python : 无法将“python”项识别为 cmdlet、函数、脚本文件或可运行程序的名称。\r\n" +
      "    + FullyQualifiedErrorId : CommandNotFoundException\r\n";
    expect(classifyLaunchRunFailure({ output: chinese })).toEqual({
      kind: "program-missing",
      program: "python",
    });
  });

  it("falls back to the command's program when only the error id is left", () => {
    expect(
      classifyLaunchRunFailure({
        output: "    + FullyQualifiedErrorId : CommandNotFoundException",
        program: "npx",
      }),
    ).toEqual({ kind: "program-missing", program: "npx" });
  });

  it("reads cmd, sh and the Windows Store Python shortcut", () => {
    expect(
      classifyLaunchRunFailure({
        output: "'deno' is not recognized as an internal or external command,",
      }),
    ).toEqual({ kind: "program-missing", program: "deno" });
    expect(classifyLaunchRunFailure({ output: "bash: hugo: command not found" })).toEqual({
      kind: "program-missing",
      program: "hugo",
    });
    expect(
      classifyLaunchRunFailure({
        output:
          "Python was not found; run without arguments to install from the Microsoft Store, or disable this shortcut",
        program: "python3",
      }),
    ).toEqual({ kind: "program-missing", program: "python3" });
  });

  it("says when the port is taken", () => {
    expect(
      classifyLaunchRunFailure({
        output: "Error: listen EADDRINUSE: address already in use :::5173",
        port: 3000,
      }),
    ).toEqual({ kind: "port-in-use", port: 5173 });
    expect(
      classifyLaunchRunFailure({
        output: "OSError: [WinError 10048] 通常每个套接字地址(协议/网络地址/端口)只允许使用一次。",
        port: 8123,
      }),
    ).toEqual({ kind: "port-in-use", port: 8123 });
  });

  it("otherwise reports a plain stop", () => {
    expect(classifyLaunchRunFailure({ output: "SyntaxError: Unexpected token" })).toEqual({
      kind: "stopped",
    });
    expect(classifyLaunchRunFailure({ output: null })).toEqual({ kind: "stopped" });
  });
});
