import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  inferDevScriptPort,
  launchCommandLine,
  parseLaunchFile,
  readProjectLaunchConfigurations,
  stripJsonComments,
} from "./projectLaunchConfigurations";
import { portsPrintedInOutput } from "./devServerManager";

const tempDirs: string[] = [];

async function makeProject(files: Record<string, string>): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "moss-launch-"));
  tempDirs.push(root);
  for (const [relative, text] of Object.entries(files)) {
    const absolute = path.join(root, relative);
    await fs.mkdir(path.dirname(absolute), { recursive: true });
    await fs.writeFile(absolute, text);
  }
  return root;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("parseLaunchFile", () => {
  it("reads the Claude-shaped file: name, executable, args, port", () => {
    const root = path.resolve("/work/shop");
    const result = parseLaunchFile({
      projectRoot: root,
      fileLabel: ".moss/launch.json",
      platform: "linux",
      text: JSON.stringify({
        version: "0.0.1",
        configurations: [
          { name: "web", runtimeExecutable: "npm", runtimeArgs: ["run", "dev"], port: 5173 },
          { name: "docs", runtimeExecutable: "bun", runtimeArgs: ["x", "serve", "my docs"] },
          { name: "staging", url: "https://staging.example.test/" },
        ],
      }),
    });
    expect(result.problems).toEqual([]);
    expect(result.configurations).toEqual([
      {
        name: "web",
        command: "npm run dev",
        cwd: root,
        port: 5173,
        url: "http://localhost:5173/",
      },
      { name: "docs", command: "bun x serve 'my docs'", cwd: root, port: null, url: null },
      {
        name: "staging",
        command: null,
        cwd: root,
        port: null,
        url: "https://staging.example.test/",
      },
    ]);
  });

  it("skips entries that cannot run, says why, and keeps the rest", () => {
    const root = path.resolve("/work/shop");
    const result = parseLaunchFile({
      projectRoot: root,
      fileLabel: ".moss/launch.json",
      text: `{
        // the app
        "configurations": [
          { "name": "app", "runtimeExecutable": "npm", "runtimeArgs": ["start"], "port": 3000, },
          { "name": "no command" },
          { "name": "app", "runtimeExecutable": "npm" },
          { "name": "outside", "runtimeExecutable": "npm", "cwd": "../elsewhere" },
          { "runtimeExecutable": "npm" },
        ],
      }`,
    });
    expect(result.configurations.map((entry) => entry.name)).toEqual(["app"]);
    expect(result.problems).toHaveLength(4);
  });

  it("reports a file that is not JSON instead of failing", () => {
    const result = parseLaunchFile({
      projectRoot: "/work",
      fileLabel: ".claude/launch.json",
      text: "{ nope",
    });
    expect(result.configurations).toEqual([]);
    expect(result.problems[0]).toMatch(/not valid JSON/);
  });
});

describe("stripJsonComments", () => {
  it("leaves comment-like text inside strings alone", () => {
    const text = '{ "url": "http://localhost:3000/" /* note */, "a": [1, 2,], }';
    expect(JSON.parse(stripJsonComments(text))).toEqual({
      url: "http://localhost:3000/",
      a: [1, 2],
    });
  });
});

describe("launchCommandLine", () => {
  it("runs a quoted program through PowerShell's call operator on Windows", () => {
    expect(launchCommandLine("C:\\Program Files\\nodejs\\npm.cmd", ["run", "dev"], "win32")).toBe(
      "& 'C:\\Program Files\\nodejs\\npm.cmd' run dev",
    );
    expect(launchCommandLine("npm", ["run", "it's"], "win32")).toBe("npm run 'it''s'");
  });
});

describe("inferDevScriptPort", () => {
  it("prefers an explicit port, else the tool's usual one", () => {
    expect(inferDevScriptPort("vite --port 4000")).toBe(4000);
    expect(inferDevScriptPort("PORT=8081 node server.js")).toBe(8081);
    expect(inferDevScriptPort("vite")).toBe(5173);
    expect(inferDevScriptPort("vite preview")).toBe(4173);
    expect(inferDevScriptPort("next dev")).toBe(3000);
    expect(inferDevScriptPort("astro dev")).toBe(4321);
    expect(inferDevScriptPort("turbo run dev")).toBeNull();
  });
});

describe("readProjectLaunchConfigurations", () => {
  it("uses .moss/launch.json first and adds .claude/launch.json entries it lacks", async () => {
    const root = await makeProject({
      ".moss/launch.json": JSON.stringify({
        configurations: [{ name: "web", runtimeExecutable: "npm", runtimeArgs: ["run", "dev"] }],
      }),
      ".claude/launch.json": JSON.stringify({
        configurations: [
          { name: "web", runtimeExecutable: "pnpm", runtimeArgs: ["dev"] },
          { name: "api", runtimeExecutable: "node", runtimeArgs: ["api.js"], port: 8787 },
        ],
      }),
    });
    const result = await readProjectLaunchConfigurations({ cwd: root }, "linux");
    expect(result.source).toBe("moss");
    expect(result.editFile).toBe(".moss/launch.json");
    expect(result.editFilePath).toBe(path.join(root, ".moss", "launch.json"));
    expect(result.configurations.map((entry) => [entry.name, entry.command])).toEqual([
      ["web", "npm run dev"],
      ["api", "node api.js"],
    ]);
  });

  it("names .claude/launch.json when that is the only file", async () => {
    const root = await makeProject({
      ".claude/launch.json": JSON.stringify({
        configurations: [{ name: "site", runtimeExecutable: "npm", runtimeArgs: ["start"] }],
      }),
    });
    const result = await readProjectLaunchConfigurations({ cwd: root }, "linux");
    expect(result.source).toBe("claude");
    expect(result.editFile).toBe(".claude/launch.json");
  });

  it("offers package.json dev scripts when there is no launch file", async () => {
    const root = await makeProject({
      "package.json": JSON.stringify({
        name: "shop",
        scripts: { build: "vite build", dev: "vite", preview: "vite preview", lint: "eslint ." },
      }),
    });
    const result = await readProjectLaunchConfigurations({ cwd: root }, "linux");
    expect(result.source).toBe("packageScripts");
    expect(result.editFile).toBe(".moss/launch.json");
    expect(result.editFilePath).toBeNull();
    expect(result.configurations.map((entry) => [entry.name, entry.port])).toEqual([
      ["dev", 5173],
      ["preview", 4173],
    ]);
  });

  it("says there is nothing when the project has neither", async () => {
    const root = await makeProject({ "README.md": "hello" });
    const result = await readProjectLaunchConfigurations({ cwd: root }, "linux");
    expect(result).toMatchObject({ source: "none", configurations: [], problems: [] });
  });
});

describe("portsPrintedInOutput", () => {
  it("reads the local addresses a dev server prints", () => {
    expect(
      portsPrintedInOutput(
        "Port 5173 is in use, trying another one...\n  ➜  Local:   http://localhost:5174/\n  ➜  Network: http://192.168.1.4:5174/\nready on http://127.0.0.1:5174",
      ),
    ).toEqual([5174]);
  });
});
