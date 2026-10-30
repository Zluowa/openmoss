import { execFileSync } from "node:child_process";
import { lstatSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";

// Test-only: create a fresh root before restricting its inherited Windows ACL.
// Accept a basename prefix only, never an existing application or user path.
export function makePrivateRuntimeTestRoot(prefix: string): string {
  if (!/^moss-[a-z0-9-]{1,80}-$/u.test(prefix)) throw new Error("Owned fixture prefix required");
  const parent = realpathSync(tmpdir());
  const directory = mkdtempSync(join(parent, prefix));
  const ownedRelative = relative(parent, directory);
  const before = lstatSync(directory);
  if (
    !ownedRelative ||
    isAbsolute(ownedRelative) ||
    ownedRelative === ".." ||
    ownedRelative.startsWith(`..${sep}`) ||
    !before.isDirectory() ||
    before.isSymbolicLink()
  )
    throw new Error("Fresh real fixture directory required");
  if (process.platform !== "win32") return directory;

  const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT;
  if (!systemRoot || !isAbsolute(systemRoot))
    throw new Error("Native Windows system root required");
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "$taskCurrent = [Security.Principal.WindowsIdentity]::GetCurrent().User",
    "$taskAcl = [Security.AccessControl.DirectorySecurity]::new()",
    "$taskAcl.SetOwner($taskCurrent)",
    "$taskAcl.SetAccessRuleProtection($true, $false)",
    "foreach ($taskSid in @($taskCurrent, [Security.Principal.SecurityIdentifier]::new('S-1-5-18'), [Security.Principal.SecurityIdentifier]::new('S-1-5-32-544'))) {",
    "  $taskRule = [Security.AccessControl.FileSystemAccessRule]::new($taskSid, 'FullControl', 'ContainerInherit, ObjectInherit', 'None', 'Allow')",
    "  $taskAcl.AddAccessRule($taskRule)",
    "}",
    "Set-Acl -LiteralPath $env:MOSS_OWNED_TEST_RUNTIME_ACL_ROOT -AclObject $taskAcl",
  ].join("\n");
  execFileSync(
    join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(script, "utf16le").toString("base64"),
    ],
    {
      encoding: "utf8",
      windowsHide: true,
      timeout: 10_000,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        SystemRoot: systemRoot,
        WINDIR: systemRoot,
        MOSS_OWNED_TEST_RUNTIME_ACL_ROOT: directory,
        PSModuleAnalysisCachePath: join(directory, "powershell-module-analysis-cache"),
      },
    },
  );
  const after = lstatSync(directory);
  if (
    after.isSymbolicLink() ||
    !after.isDirectory() ||
    before.dev !== after.dev ||
    before.ino !== after.ino
  )
    throw new Error("Owned fixture directory identity changed");
  return directory;
}
