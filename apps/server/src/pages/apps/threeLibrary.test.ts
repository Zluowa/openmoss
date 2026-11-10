// FILE: threeLibrary.test.ts
// Purpose: The shipped r182 ESM entry and its matching core form a complete local module.
// Layer: Server static asset tests

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { expect, it } from "vitest";

import { readInlineVisualizationLibrary } from "../../inlineVisualizationAccess";

it("ships the exact matching Three r182 module, core and complete MIT license", async () => {
  const module = await readInlineVisualizationLibrary("three.module.js", undefined);
  const core = await readInlineVisualizationLibrary("three.core.js", undefined);
  expect(createHash("sha256").update(module!.contents).digest("hex")).toBe(
    "d835eab0b3bca3fdfd51e2ce7d06911f4a089b08db73cc3cd70fe5e3005a623f",
  );
  expect(createHash("sha256").update(core!.contents).digest("hex")).toBe(
    "283be43b2229e15f46dac84cd19354ede5f06cac7ffb185e765cfcfb2c1eec90",
  );
  const license = await readFile(
    new URL("../../../../web/public/inline-visualization-libs/three.LICENSE.txt", import.meta.url),
    "utf8",
  );
  expect(license).toContain("The MIT License");
  expect(license).toContain("Permission is hereby granted");
  expect(license).toContain("THE SOFTWARE IS PROVIDED");
});

it("loads the actual shipped ESM closure without a package install or network", async () => {
  const entry = new URL(
    "../../../../web/public/inline-visualization-libs/three.module.js",
    import.meta.url,
  ).href;
  const three = (await import(entry)) as {
    REVISION: string;
    Vector3: new (x: number, y: number, z: number) => { length: () => number };
  };
  expect(three.REVISION).toBe("182");
  expect(new three.Vector3(3, 4, 0).length()).toBe(5);
});
