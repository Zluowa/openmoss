import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { translateZhCnPresentationText } from "./zhCN";

const AUTH_DIR = resolve(__dirname, "../components/auth");

/** Every English sentence a person can read on the Google and account screens. */
function literalsIn(file: string): string[] {
  const source = readFileSync(resolve(AUTH_DIR, file), "utf8");
  const literals = new Set<string>();
  for (const [, value] of source.matchAll(/"([A-Z][^"\n]*[a-z.…][^"\n]*)"/gu)) {
    if (value && /\s/u.test(value)) literals.add(value);
  }
  for (const [, value] of source.matchAll(/>\s*([A-Z][^<>{}\n]*[a-z.…])\s*</gu)) {
    if (value && /\s/u.test(value)) literals.add(value.trim());
  }
  return [...literals];
}

describe("account copy in zh-CN", () => {
  it.each([
    "This Google sign-in request is invalid or has expired. Start again.",
    "Moss could not complete Google sign-in. Try again.",
    "Google sign-in was cancelled",
    "You cancelled at Google. Try again when you’re ready.",
    "Google didn’t complete the sign-in. Try again.",
    "Open Settings → Usage to see quota and buy credits.",
    "Return to sign in",
    "Your Moss session has expired. Sign in again.",
    "Couldn’t connect to Moss. Check your connection and try again.",
  ])("translates %s", (copy) => {
    expect(translateZhCnPresentationText(copy)).not.toBe(copy);
  });

  it("leaves no English sentence on the Google sign-in and account screens", () => {
    const untranslated = literalsIn("mossCloudAuth.logic.ts")
      .concat(literalsIn("MossCloudAuthPages.tsx"))
      // Email and password screens are retired; the Google-only service never shows them.
      .filter((copy) => !/email|password|verification link|reset link|sign-in link is/iu.test(copy))
      .filter((copy) => translateZhCnPresentationText(copy) === copy);

    expect(untranslated).toEqual([]);
  });
});
