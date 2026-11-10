// FILE: npm.ts
// Purpose: npm registry metadata and integrity-checked tarball downloads for agent runtime bumps.
// Layer: Release/build helper (agent runtime bumps)

import * as Path from "node:path";
import type { NpmVersionDocument } from "./bun-lock.ts";
import { downloadToCache, fetchJson, type DownloadedFile } from "./download.ts";

/** The canonical registry recorded in locks; mirrors serve the same integrity-checked bytes. */
export const NPM_CANONICAL_REGISTRY = "https://registry.npmjs.org";
export const NPM_REGISTRY_ALIASES: Readonly<Record<string, string>> = {
  npmjs: NPM_CANONICAL_REGISTRY,
  npmmirror: "https://registry.npmmirror.com",
};

export function resolveRegistry(value: string | undefined): string {
  const registry = NPM_REGISTRY_ALIASES[value ?? "npmjs"] ?? value!;
  if (!/^https:\/\/[^/]+(?:\/[^?#]*)?$/u.test(registry)) {
    throw new Error(`--registry must be npmjs, npmmirror or an https URL (got ${value}).`);
  }
  return registry.replace(/\/+$/u, "");
}

const encodeName = (name: string) => name.replace("/", "%2f");

export async function fetchDistTags(
  registry: string,
  name: string,
): Promise<Record<string, string>> {
  const tags = await fetchJson(
    `${registry}/-/package/${encodeName(name)}/dist-tags`,
    `${name} dist-tags`,
  );
  if (!tags || typeof tags !== "object") throw new Error(`${name}: malformed dist-tags.`);
  return tags as Record<string, string>;
}

export async function fetchVersionDocument(
  registry: string,
  name: string,
  version: string,
): Promise<NpmVersionDocument & Record<string, unknown>> {
  const document = (await fetchJson(
    `${registry}/${encodeName(name)}/${encodeURIComponent(version)}`,
    `${name}@${version}`,
  )) as NpmVersionDocument & Record<string, unknown>;
  if (document?.name !== name || document.version !== version) {
    throw new Error(
      `${name}@${version}: registry returned ${document?.name}@${document?.version}.`,
    );
  }
  if (!/^sha512-[A-Za-z0-9+/]+=*$/u.test(document.dist?.integrity ?? "")) {
    throw new Error(`${name}@${version}: registry document has no sha512 integrity.`);
  }
  return document;
}

/** Downloads the version's tarball and checks it against the registry's sha512 integrity. */
export async function downloadNpmTarball(input: {
  readonly document: NpmVersionDocument;
  readonly cacheDir: string;
}): Promise<DownloadedFile> {
  const { document } = input;
  const fileName = `${document.name.split("/").at(-1)}-${document.version}.tgz`;
  return downloadToCache({
    url: document.dist.tarball,
    cacheDir: input.cacheDir,
    cacheKey: Path.join("npm", ...document.name.split("/"), fileName),
    expected: { integrity: document.dist.integrity },
    label: `${document.name}@${document.version}`,
  });
}
