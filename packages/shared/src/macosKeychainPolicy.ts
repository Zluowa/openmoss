// Purpose: Keep every macOS Keychain read exact-name and fail closed.
// Layer: Shared security policy for server and deployment tooling.

const FIND_GENERIC_PASSWORD = ["find", "generic", "password"].join("-");
const FORBIDDEN_BULK_READ = ["dump", "keychain"].join("-");
const MAX_REFERENCE_LENGTH = 256;

export class MacosKeychainPolicyError extends Error {
  readonly code = "MACOS_KEYCHAIN_COMMAND_REJECTED";
}

function exactReference(value: string): string {
  if (
    value.length === 0 ||
    value.length > MAX_REFERENCE_LENGTH ||
    /[*?\[\]]/u.test(value) ||
    value.includes("\0") ||
    value.includes("\r") ||
    value.includes("\n")
  ) {
    throw new MacosKeychainPolicyError("macOS Keychain reads require an exact reference");
  }
  return value;
}

export function exactGenericPasswordReadArgs(input: {
  readonly service: string;
  readonly account: string;
  readonly revealSecret: boolean;
}): string[] {
  const args = [
    FIND_GENERIC_PASSWORD,
    "-s",
    exactReference(input.service),
    "-a",
    exactReference(input.account),
  ];
  if (input.revealSecret) args.push("-w");
  return args;
}

export function assertSafeMacosSecurityCommand(args: readonly string[]): void {
  if (args.includes(FORBIDDEN_BULK_READ)) {
    throw new MacosKeychainPolicyError("bulk macOS Keychain reads are forbidden");
  }
  const revealSecret = args.at(-1) === "-w";
  const expectedLength = revealSecret ? 6 : 5;
  if (
    args.length !== expectedLength ||
    args[0] !== FIND_GENERIC_PASSWORD ||
    args[1] !== "-s" ||
    args[3] !== "-a" ||
    (revealSecret && args[5] !== "-w")
  ) {
    throw new MacosKeychainPolicyError(
      "macOS Keychain reads require exact service and account arguments",
    );
  }
  exactReference(args[2] ?? "");
  exactReference(args[4] ?? "");
}
