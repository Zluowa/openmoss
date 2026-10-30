import { describe, expect, it } from "vitest";
import type { PluginOption } from "vite";

import { withoutVitePlugin } from "./vitePluginConfig";

describe("browser Vite plugin project", () => {
  it("returns an empty plugin list for an undefined project", () => {
    const excludedPlugin = { name: "moss:react-compiler-babel" } as PluginOption;

    expect(withoutVitePlugin(undefined, excludedPlugin)).toEqual([]);
  });

  it("removes one nested reference while retaining other Babel and ordinary plugins", () => {
    const excludedPlugin = { name: "moss:react-compiler-babel" } as PluginOption;
    const otherBabelPlugin = { name: "moss:other-babel-transform" } as PluginOption;
    const ordinaryPlugin = { name: "moss:ordinary-plugin" } as PluginOption;
    const nestedGroup = [excludedPlugin, otherBabelPlugin] as PluginOption[];

    expect(withoutVitePlugin([nestedGroup, ordinaryPlugin], excludedPlugin)).toEqual([
      [otherBabelPlugin],
      ordinaryPlugin,
    ]);
  });

  it("retains unknown plugin option shapes instead of guessing", () => {
    const unknownPluginShape = Promise.resolve([
      { name: "moss:unknown" },
    ]) as unknown as PluginOption;
    const ordinaryPlugin = { name: "moss:ordinary-plugin" } as PluginOption;
    const excludedPlugin = { name: "moss:react-compiler-babel" } as PluginOption;

    expect(withoutVitePlugin([unknownPluginShape, ordinaryPlugin], excludedPlugin)).toEqual([
      unknownPluginShape,
      ordinaryPlugin,
    ]);
  });
});
