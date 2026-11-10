import { realpathSync, statSync } from "node:fs";
import { chmod, lstat, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";

// Include the longest socket basename each owner creates. The native driver binds
// its generation socket after the host has already started listening on host.sock.
const layouts = {
  host: { prefix: "moss-cua-", socket: "driver-00000000.sock" },
  frames: { prefix: "moss-frames-", socket: "tap-00000000.sock" },
} as const;

type SocketOwner = keyof typeof layouts;

export function computerSocketPathFits(
  root: string,
  owner: SocketOwner,
  platform: NodeJS.Platform,
): boolean {
  // Leave one byte for the terminating NUL in sockaddr_un.sun_path.
  const maxBytes = platform === "linux" ? 107 : 103;
  const layout = layouts[owner];
  return Buffer.byteLength(posix.join(root, `${layout.prefix}XXXXXX`, layout.socket)) <= maxBytes;
}

export function computerSocketTempRoot(owner: SocketOwner): string {
  const preferred = tmpdir();
  if (process.platform === "win32") return preferred;

  const canonical = realpathSync.native(preferred);
  if (computerSocketPathFits(canonical, owner, process.platform)) {
    return computerSocketPathFits(preferred, owner, process.platform) ? preferred : canonical;
  }

  const fallback = realpathSync.native("/tmp");
  const stat = statSync(fallback);
  if (
    !computerSocketPathFits(fallback, owner, process.platform) ||
    !stat.isDirectory() ||
    (stat.uid !== 0 && stat.uid !== process.getuid?.()) ||
    ((stat.mode & 0o022) !== 0 && (stat.mode & 0o1000) === 0)
  ) {
    throw new Error(
      "Computer use requires a short, protected temporary directory for Unix sockets.",
    );
  }
  return fallback;
}

export interface ComputerSocketDirectory {
  readonly path: string;
  readonly remove: () => Promise<void>;
}

export async function createComputerSocketDirectory(
  owner: SocketOwner,
): Promise<ComputerSocketDirectory> {
  // mkdtemp on POSIX creates the new directory with mode 0700, even under shared /tmp.
  const path = await mkdtemp(join(computerSocketTempRoot(owner), layouts[owner].prefix));
  const created = await lstat(path, { bigint: true });
  const directory: ComputerSocketDirectory = {
    path,
    async remove() {
      let current;
      try {
        current = await lstat(path, { bigint: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
        throw error;
      }
      if (current.isDirectory() && current.dev === created.dev && current.ino === created.ino) {
        await rm(path, { recursive: true, force: true });
      }
    },
  };
  try {
    await chmod(path, 0o700);
    return directory;
  } catch (error) {
    await directory.remove();
    throw error;
  }
}
