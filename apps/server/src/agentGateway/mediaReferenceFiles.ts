import { realpath } from "node:fs/promises";
import path from "node:path";
import { MossMediaJobsError } from "../mossMediaJobsService";
import { readRegularFileNoFollow } from "../workspaceImport/safeFile";

const MAX_REFERENCE_BYTES = 5 * 1024 * 1024;
function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}
function imageMime(bytes: Buffer): string | null {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
    return "image/png";
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return "image/jpeg";
  if (bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP")
    return "image/webp";
  return null;
}

/** Explicit references may read only regular images inside this caller's workspace. */
export async function readWorkspaceMediaReferences(
  root: string,
  references: readonly string[],
  maximumReferences = 4,
): Promise<string[]> {
  if (
    !Number.isInteger(maximumReferences) ||
    maximumReferences < 1 ||
    maximumReferences > 30 ||
    references.length > maximumReferences
  )
    throw new MossMediaJobsError("invalid_reference_path");
  return readImagesWithinBudget(root, references);
}

/** References and a mask share one local byte budget and the same path checks. */
export async function readWorkspaceMediaEditFiles(
  root: string,
  references: readonly string[],
  maskPath: string,
): Promise<{ references: string[]; maskImage: string }> {
  if (references.length > 4) throw new MossMediaJobsError("invalid_reference_path");
  const encoded = await readImagesWithinBudget(root, [...references, maskPath]);
  return { references: encoded.slice(0, -1), maskImage: encoded.at(-1)! };
}

async function readImagesWithinBudget(
  root: string,
  references: readonly string[],
): Promise<string[]> {
  const realRoot = await realpath(root);
  const results: string[] = [];
  let remaining = MAX_REFERENCE_BYTES;
  for (const reference of references) {
    const candidate = path.resolve(realRoot, reference);
    if (!isWithin(realRoot, candidate)) throw new MossMediaJobsError("invalid_reference_path");
    const resolved = await realpath(candidate);
    if (!isWithin(realRoot, resolved)) throw new MossMediaJobsError("invalid_reference_path");
    // Keep the bounded descriptor/identity checks used by workspace imports.
    const bytes = await readRegularFileNoFollow(candidate, remaining);
    if ((await realpath(candidate)) !== resolved)
      throw new MossMediaJobsError("invalid_reference_path");
    const mime = imageMime(bytes);
    if (!mime) throw new MossMediaJobsError("invalid_reference_type");
    remaining -= bytes.length;
    results.push(`data:${mime};base64,${bytes.toString("base64")}`);
  }
  return results;
}
