// FILE: crate-source.ts
// Purpose: Bind omitted crate notices to the exact GitHub source recorded in its checked archive.
// Layer: Release/build evidence

import { posix } from "node:path";
import { readCargoManifestLicense } from "./cargo.ts";
import type { RepoArchiveIndex } from "./repo-archive.ts";

export interface CrateSourceProvenance {
  readonly source: string;
  readonly directory?: string;
}

// This older release predates Cargo VCS metadata. Its original Cargo.toml and
// every published Rust source (seven files) match this exact commit byte for
// byte. A version label alone is insufficient; require the checked crate hash.
const REVIEWED_SOURCE_PINS: Readonly<
  Record<string, { readonly checksum: string; readonly source: string; readonly directory: string }>
> = {
  "difflib-0.4.0": {
    checksum: "6184e33543162437515c2e2b48714794e37845ec9851711914eec9d308f6ebe8",
    source: "git+https://github.com/DimaKudosh/difflib#f035fb8e656f27119e23eca9d5b996df14f3885e",
    directory: "",
  },
};

export function readCrateSourceProvenance(
  index: RepoArchiveIndex,
  checkedArchiveChecksum?: string,
): CrateSourceProvenance | null {
  const pin = REVIEWED_SOURCE_PINS[index.root];
  if (pin && pin.checksum === checkedArchiveChecksum)
    return { source: pin.source, directory: pin.directory };
  const manifest = readCargoManifestLicense(index.manifests.get("") ?? "");
  const repository = manifest.repository ?? manifest.homepage;
  const vcsBytes = index.extras.get(".cargo_vcs_info.json");
  if (!repository || !vcsBytes) return null;
  let url: URL;
  try {
    url = new URL(repository);
  } catch {
    return null;
  }
  if (
    url.protocol !== "https:" ||
    url.hostname !== "github.com" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    return null;
  // Cargo repository URLs may point at the crate's web directory. The pinned
  // revision still comes exclusively from the checked crate's VCS metadata.
  const match = /^\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?(?:\/tree\/[^?#]+)?\/?$/u.exec(
    url.pathname,
  );
  if (!match) return null;
  let vcs: {
    git?: { sha1?: unknown; dirty?: unknown };
    path_in_vcs?: unknown;
  };
  try {
    vcs = JSON.parse(vcsBytes.toString("utf8"));
  } catch {
    return null;
  }
  if (!vcs || typeof vcs !== "object") return null;
  const commit = vcs.git?.sha1;
  if (
    typeof commit !== "string" ||
    !/^[0-9a-f]{40}$/u.test(commit) ||
    (vcs.git?.dirty !== undefined && vcs.git.dirty !== false)
  )
    return null;
  const source = `git+https://github.com/${match[1]}/${match[2]}#${commit}`;
  // Older Cargo archives omit this field; resolve their unique manifest from
  // the exact snapshot instead of asserting that the crate lives at its root.
  if (vcs.path_in_vcs === undefined) return { source };
  const rawPath = vcs.path_in_vcs;
  if (
    typeof rawPath !== "string" ||
    rawPath.includes("\\") ||
    posix.isAbsolute(rawPath) ||
    rawPath.split("/").includes("..")
  )
    return null;
  const directory = posix.normalize(rawPath).replace(/^\.$/u, "");
  return { source, directory };
}
