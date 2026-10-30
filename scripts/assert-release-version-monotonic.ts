// FILE: assert-release-version-monotonic.ts
// Purpose: Fails a stable publication unless it is strictly newer than every
// already-published stable release tag supplied on stdin.

import { readFileSync } from "node:fs";

import { assertStableReleaseVersionMonotonic } from "./lib/release-update-policy.ts";

const version = process.argv[2];
if (!version || process.argv.length !== 3) {
  throw new Error("Usage: node scripts/assert-release-version-monotonic.ts <version>");
}

const publishedStableTags = readFileSync(0, "utf8")
  .split(/\r?\n/)
  .filter((tag) => tag.length > 0);

assertStableReleaseVersionMonotonic(version, publishedStableTags);
console.log(
  `Stable release v${version} is newer than ${publishedStableTags.length} published stable release(s).`,
);
