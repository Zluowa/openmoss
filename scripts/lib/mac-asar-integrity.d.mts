export interface PackagedAsarIntegrityReceipt {
  archiveSha256: string;
  headerSha256: string;
  payloadSha256: string;
  plistSha256: string;
  packedFiles: number;
  unpackedFiles: number;
}
export function verifyPackagedAsarIntegrity(appPath: string): PackagedAsarIntegrityReceipt;
export function parseAsarHeader(
  prefix: Buffer,
  archiveSize: number,
): {
  header: Record<string, unknown>;
  entries: Array<{
    path: string;
    node: Record<string, unknown>;
    unpacked: boolean;
    offset: number | null;
  }>;
  payloadOffset: number;
  headerSha256: string;
};
export function encodeAsarHeader(header: Record<string, unknown>): Buffer;
export interface AsarSigningHooks {
  beforeOpen?: (filePath: string) => void;
  beforeCommit?: (pending: { pendingArchive: string; pendingPlist: string }) => void;
  afterArchiveCommit?: () => void;
  /** Defaults to the real directory fsync; permits deterministic I/O fault tests. */
  syncParent?: (filePath: string) => void;
  runCommand?: (command: string, argv: string[]) => { status: number | null; error?: unknown };
}
export function bindMacBuildOnlyAsarSigning(
  appPath: string,
  hooks?: AsarSigningHooks,
): {
  /** Keeps bound non-Mach-O unpacked inputs out of codesign without relaxing identity checks. */
  shouldIgnoreFile(filePath: string): boolean;
  refresh(): PackagedAsarIntegrityReceipt & { refreshCount: number; changedNativeFiles: number };
  finish(): PackagedAsarIntegrityReceipt & { refreshCount: number };
};
