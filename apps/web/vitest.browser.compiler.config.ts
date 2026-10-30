import { transformAsync } from "@babel/core";
import type { Plugin } from "vite";
import { defineConfig, mergeConfig } from "vitest/config";

import browserConfig from "./vitest.browser.config";

// The normal browser harness deliberately removes the build-only React Compiler
// plugin. Compile just the transcript component here so the render-budget test
// exercises production memoization without slowing every browser spec.
const timelineCompilerPlugin: Plugin = {
  name: "moss:timeline-react-compiler-test",
  enforce: "pre",
  async transform(code, id) {
    if (!/[/\\]MessagesTimeline\.tsx(?:\?|$)/u.test(id)) return null;
    const compiled = await transformAsync(code, {
      babelrc: false,
      configFile: false,
      filename: id,
      parserOpts: { plugins: ["typescript", "jsx"] },
      plugins: ["babel-plugin-react-compiler"],
      sourceMaps: false,
    });
    if (!compiled?.code) {
      throw new Error("React Compiler did not return MessagesTimeline output.");
    }
    return { code: compiled.code, map: null };
  },
};

const compilerConfig = mergeConfig(
  browserConfig,
  defineConfig({
    cacheDir: "node_modules/.vite/vitest-compiler",
    // Keep this isolated lane deterministic: compiler output introduces the
    // runtime import, while LegendList reaches a nested CommonJS shim.
    optimizeDeps: {
      force: true,
      holdUntilCrawlEnd: true,
      include: [
        "@legendapp/list/react",
        "@legendapp/list > use-sync-external-store/shim",
        "react/compiler-runtime",
      ],
    },
    define: {
      "import.meta.env.VITE_MOSS_BROWSER_REACT_COMPILER": JSON.stringify("1"),
    },
    plugins: [timelineCompilerPlugin],
  }),
);

export default defineConfig({
  ...compilerConfig,
  test: {
    ...compilerConfig.test,
    // mergeConfig concatenates include arrays; replace the broad browser glob.
    include: ["src/components/chat/MessagesTimeline.renderScope.browser.tsx"],
  },
});
