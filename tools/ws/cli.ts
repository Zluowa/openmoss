// ws: the one way agents get and return machine resources. See tools/ws/README.md.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "./lib/args.ts";
import {
  cmdDoctor,
  cmdLane,
  cmdList,
  cmdNew,
  cmdReap,
  cmdRelease,
  consoleIo,
  type Io,
} from "./lib/commands.ts";
import { samePath } from "./lib/paths.ts";
import { loadProfile, ProfileError, type Profile } from "./lib/profile.ts";

const USAGE = `usage: bun run ws <command>

  new <name> [--base origin/main] [--branch <type>/<slug>] [--owner <session>] [--reuse-branch] [--no-deps]
  list [--json] [--no-size] [--all-sizes] [--fresh] [--size-budget <seconds, default 30>]
  release <name> [--dry-run] [--force]
  reap [--apply] [--no-size] [--fresh]          (dry run unless --apply)
  lane <name> [--owner <session>] [--shell] -- <command...>
  doctor [--no-fail]

The machine profile is read from $MOSS_WS_PROFILE, default ~/.moss-ws/profile.json.`;

const VALUE_FLAGS = ["base", "branch", "owner", "size-budget"];

export async function main(
  argv: readonly string[],
  io: Io = consoleIo,
  profileOverride?: Profile,
): Promise<number> {
  const [command, ...rest] = argv;
  if (!command || command === "help" || command === "--help" || command === "-h") {
    io.out(USAGE);
    return command ? 0 : 2;
  }
  let args;
  try {
    args = parseArgs(rest, VALUE_FLAGS);
  } catch (error) {
    io.err((error as Error).message);
    return 2;
  }
  let profile: Profile;
  try {
    profile = profileOverride ?? loadProfile();
  } catch (error) {
    if (error instanceof ProfileError) {
      io.err(error.message);
      return 2;
    }
    throw error;
  }
  switch (command) {
    case "new":
      return cmdNew(profile, args, io);
    case "list":
      return cmdList(profile, args, io);
    case "release":
      return cmdRelease(profile, args, io);
    case "reap":
      return cmdReap(profile, args, io);
    case "lane":
      return cmdLane(profile, args, io);
    case "doctor":
      return cmdDoctor(profile, args, io);
    default:
      io.err(`unknown command ${command}\n${USAGE}`);
      return 2;
  }
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  samePath(path.resolve(process.argv[1]), fileURLToPath(import.meta.url));

if (invokedDirectly) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error: unknown) => {
      process.stderr.write(
        `ws: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
      );
      process.exit(1);
    },
  );
}
