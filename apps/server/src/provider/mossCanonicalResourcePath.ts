import * as nodePath from "node:path";

import type { MossCanonicalResourceMutationPrepareInput } from "@synara/contracts";
import { getMossSourceLayout } from "@synara/shared/mossSourceLayout";

import { MossResourceImportError } from "./mossResourceImport.ts";
import { slugifyResourceName } from "./mossCreateResource.ts";

type CanonicalResourcePathInput = Omit<MossCanonicalResourceMutationPrepareInput, "action"> & {
  readonly action?: MossCanonicalResourceMutationPrepareInput["action"];
};

function derivedRelativePath(input: CanonicalResourcePathInput): string {
  const layout = getMossSourceLayout(input.cwd);
  if (input.kind === "mcp") {
    return nodePath.relative(input.cwd, layout.mcpConfig).split(nodePath.sep).join("/");
  }
  const root = input.kind === "skill" ? layout.skillsRoot : layout.pluginsRoot;
  const slug = slugifyResourceName(input.name);
  if (!slug) {
    throw new MossResourceImportError(
      "invalid-identity",
      "The canonical resource name is invalid.",
    );
  }
  const artifact =
    input.kind === "skill"
      ? nodePath.join(root, slug, "SKILL.md")
      : nodePath.join(root, slug, "plugin.json");
  return nodePath.relative(input.cwd, artifact).split(nodePath.sep).join("/");
}

/**
 * Validate a legacy path hint without allowing the client to choose a target.
 * The mutation service receives the path-stripped input and derives the target
 * from the registered workspace layout plus the server-validated name/slug.
 */
export function validateCanonicalResourcePathHint(input: CanonicalResourcePathInput): void {
  if (!("path" in input) || input.path === undefined) return;
  const raw = input.path.trim();
  const unsafe =
    raw.length === 0 ||
    raw.includes("\0") ||
    raw.startsWith("~") ||
    nodePath.isAbsolute(raw) ||
    /^[A-Za-z]:[\\/]/u.test(raw) ||
    raw.startsWith("\\\\") ||
    raw
      .split(/[\\/]+/u)
      .some((segment) => segment.length === 0 || segment === "." || segment === "..");
  if (unsafe) {
    throw new MossResourceImportError(
      "path-traversal",
      "Canonical resource path hints must be safe, relative, and dot-free.",
    );
  }
  const normalized = raw.replace(/[\\]+/gu, "/");
  if (normalized !== derivedRelativePath(input)) {
    throw new MossResourceImportError(
      "invalid-identity",
      "Canonical resource path does not match the server-derived resource name and slug.",
    );
  }
}
