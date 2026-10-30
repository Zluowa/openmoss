import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const bulkReadToken = ["dump", "keychain"].join("-");
const genericReadToken = ["find", "generic", "password"].join("-");
const sourceExtensions = /\.(?:cjs|js|json|mjs|sh|ts|tsx|yaml|yml)$/u;
const testFile = /(?:^|\/)(?:__tests__\/.*|[^/]+\.(?:integration\.)?test\.[^/]+)$/u;
const allowedGenericReadSources = new Set([
  "packages/shared/src/macosKeychainPolicy.ts",
  "scripts/deploy/moss-provider-credential-core.ts",
  "apps/server/src/providerUsage/credentials.ts",
]);

const files = execFileSync(
  "git",
  ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
  { encoding: "utf8" },
)
  .split("\0")
  .filter((file) => sourceExtensions.test(file));
const violations: string[] = [];

for (const file of files) {
  const source = readFileSync(file, "utf8");
  if (source.includes(bulkReadToken)) violations.push(`${file}: bulk keychain read token`);
  if (
    source.includes(genericReadToken) &&
    !testFile.test(file) &&
    !allowedGenericReadSources.has(file)
  ) {
    violations.push(`${file}: unreviewed generic-password read`);
  }
}

for (const [file, required] of [
  [
    "scripts/deploy/moss-provider-credential-core.ts",
    ["exactGenericPasswordReadArgs", "assertSafeMacosSecurityCommand"],
  ],
  [
    "apps/server/src/providerUsage/credentials.ts",
    ["account: string", "exactGenericPasswordReadArgs", "assertSafeMacosSecurityCommand"],
  ],
] as const) {
  const source = readFileSync(file, "utf8");
  for (const marker of required) {
    if (!source.includes(marker)) violations.push(`${file}: missing exact-name marker`);
  }
}

if (violations.length > 0) {
  throw new Error(`Keychain command policy failed:\n${violations.join("\n")}`);
}

console.log(
  JSON.stringify({
    ok: true,
    policy: "exact-service-and-account-only",
    executableSourcesChecked: files.length,
    bulkReads: 0,
    ambiguousReads: 0,
  }),
);
