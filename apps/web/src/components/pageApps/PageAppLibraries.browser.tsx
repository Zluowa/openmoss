// FILE: PageAppLibraries.browser.tsx
// Purpose: Exact local libraries execute in the production opaque sandbox with no network.
// Layer: Web browser tests (server response preparation via a local test command)

import {
  buildPageAppFrameRuntime,
  injectPageAppFrameRuntime,
} from "@moss/shared/pageAppFrameRuntime";
import { describe, expect, it, vi } from "vitest";
import { commands } from "vitest/browser";
import { render } from "vitest-browser-react";

import { pageAppContentSecurityPolicy } from "@moss/shared/pageAppContentPolicy";
import { pageAppIframeSandbox } from "./AppPageFrame";

declare module "vitest/internal/browser" {
  interface BrowserCommands {
    prepareAppLibraryFixture: (html: string) => Promise<{ html: string; offlineReady: boolean }>;
  }
}

describe("local app libraries", () => {
  it("runs D3, Chart and the Three core closure as ESM with exact data fonts in the opaque sandbox", async () => {
    await commands.beginAppThumbnailRequestProbe("Local ESM fixture");
    const csp = pageAppContentSecurityPolicy({ parentOrigin: window.location.origin, opaque: true })
      .split("; ")
      .filter(
        (directive) =>
          !directive.startsWith("sandbox ") && !directive.startsWith("frame-ancestors "),
      )
      .join("; ");
    const source = `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${csp}"><style>
      @font-face{font-family:"Fixture Inter";src:url("https://cdn.jsdelivr.net/npm/@fontsource-variable/inter@5.2.8/files/inter-latin-wght-normal.woff2");font-weight:100 900}
      @font-face{font-family:"Fixture Mono";src:url("https://cdn.jsdelivr.net/npm/@fontsource-variable/jetbrains-mono@5.2.8/files/jetbrains-mono-latin-wght-normal.woff2");font-weight:100 800}
      body{font-family:"Fixture Inter"}code{font-family:"Fixture Mono"}
    </style></head><body><h1>Offline modules</h1><code>Three r182</code><svg width="200" height="100"></svg><canvas id="chart" width="240" height="140"></canvas><script type="module">
      import {select} from "https://cdn.jsdelivr.net/npm/d3@7.9.0/+esm";
      import Chart from "https://cdn.jsdelivr.net/npm/chart.js@4.5.1/+esm";
      import * as THREE from "https://cdn.jsdelivr.net/npm/three@0.182.0/build/three.module.js";
      select("svg").append("circle").attr("cx",50).attr("cy",50).attr("r",30).attr("fill","coral");
      new Chart(document.getElementById("chart"),{type:"bar",data:{labels:["A","B"],datasets:[{data:[2,4],backgroundColor:"coral"}]},options:{responsive:false,animation:false}});
      const mesh=new THREE.Mesh(new THREE.BoxGeometry(),new THREE.MeshBasicMaterial());
      const fonts=await Promise.all([document.fonts.load('16px "Fixture Inter"'),document.fonts.load('16px "Fixture Mono"')]);
      parent.postMessage({kind:"local-esm-ready",chart:Chart.version,three:THREE.REVISION,vertices:mesh.geometry.attributes.position.count,circles:document.querySelectorAll("circle").length,fonts:fonts.map(items=>items.length),painted:Array.from(document.getElementById("chart").getContext("2d").getImageData(0,0,240,140).data).some(value=>value!==0)},${JSON.stringify(window.location.origin)});
    </script></body></html>`;
    const prepared = await commands.prepareAppLibraryFixture(source);
    expect(prepared.offlineReady).toBe(true);
    const html = injectPageAppFrameRuntime(
      prepared.html,
      buildPageAppFrameRuntime({ parentOrigin: window.location.origin }),
    );
    const url = URL.createObjectURL(new Blob([html], { type: "text/html" }));
    let received: unknown;
    let receivedOrigin: string | undefined;
    const observe = (event: MessageEvent) => {
      if (event.data?.kind === "local-esm-ready") {
        received = event.data;
        receivedOrigin = event.origin;
      }
    };
    window.addEventListener("message", observe);
    const mounted = await render(
      <iframe
        title="Local ESM fixture"
        src={url}
        sandbox={pageAppIframeSandbox(false)}
        style={{ width: 600, height: 400, border: 0 }}
      />,
    );
    try {
      await vi.waitFor(
        () =>
          expect(received).toEqual({
            kind: "local-esm-ready",
            chart: "4.5.1",
            three: "182",
            vertices: 24,
            circles: 1,
            fonts: [1, 1],
            painted: true,
          }),
        { timeout: 4_000 },
      );
      expect(receivedOrigin).toBe("null");
      expect(await commands.endAppThumbnailRequestProbe()).toEqual([]);
    } finally {
      window.removeEventListener("message", observe);
      await mounted.unmount();
      URL.revokeObjectURL(url);
      await commands.endAppThumbnailRequestProbe();
    }
  });

  it("runs D3 SVG and Chart.js canvas from exact local bytes with production CSP", async () => {
    await commands.beginAppThumbnailRequestProbe("Local library fixture");
    const csp = pageAppContentSecurityPolicy({ parentOrigin: window.location.origin, opaque: true })
      .split("; ")
      .filter(
        (directive) =>
          !directive.startsWith("sandbox ") && !directive.startsWith("frame-ancestors "),
      )
      .join("; ");
    const source = `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${csp}"><script src="https://cdn.jsdelivr.net/npm/d3@7.9.0/dist/d3.min.js"></script><script src="https://cdn.jsdelivr.net/npm/chart.js@4.5.1/dist/chart.umd.js"></script></head><body><h1>Offline charts</h1><svg width="200" height="100"></svg><canvas id="chart" width="240" height="140"></canvas><script>
      d3.select("svg").append("circle").attr("cx",50).attr("cy",50).attr("r",30).attr("fill","coral");
      new Chart(document.getElementById("chart"),{type:"bar",data:{labels:["A","B"],datasets:[{data:[2,4],backgroundColor:"coral"}]},options:{responsive:false,animation:false}});
      parent.postMessage({kind:"local-libraries-ready",d3:d3.version,chart:Chart.version,circles:document.querySelectorAll("circle").length,painted:Array.from(document.getElementById("chart").getContext("2d").getImageData(0,0,240,140).data).some(function(value){return value!==0;})},${JSON.stringify(window.location.origin)});
    </script></body></html>`;
    const prepared = await commands.prepareAppLibraryFixture(source);
    expect(prepared.offlineReady).toBe(true);
    const html = injectPageAppFrameRuntime(
      prepared.html,
      buildPageAppFrameRuntime({ parentOrigin: window.location.origin }),
    );
    const url = URL.createObjectURL(new Blob([html], { type: "text/html" }));
    let received: unknown;
    const observe = (event: MessageEvent) => {
      if (event.data?.kind === "local-libraries-ready") received = event.data;
    };
    window.addEventListener("message", observe);
    const mounted = await render(
      <iframe
        title="Local library fixture"
        src={url}
        sandbox={pageAppIframeSandbox(false)}
        style={{ width: 600, height: 400, border: 0 }}
      />,
    );
    try {
      await vi.waitFor(
        () =>
          expect(received).toEqual({
            kind: "local-libraries-ready",
            d3: "7.9.0",
            chart: "4.5.1",
            circles: 1,
            painted: true,
          }),
        { timeout: 3_000 },
      );
      expect(await commands.endAppThumbnailRequestProbe()).toEqual([]);
    } finally {
      window.removeEventListener("message", observe);
      await mounted.unmount();
      URL.revokeObjectURL(url);
      await commands.endAppThumbnailRequestProbe();
    }
  });
});
