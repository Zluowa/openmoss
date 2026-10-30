// Windows test bridge for the owned extensionless fake gh; no production command is replaced.
import childProcess from "node:child_process";
import { realpathSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { dirname, join } from "node:path";

if (
  process.env.NODE_ENV !== "test" ||
  !process.env.GH_FIXTURE_PATH ||
  !process.env.GH_CALL_LOG_PATH
) {
  throw new Error("Release workflow fake gh preload requires its test fixture environment.");
}
const fixtureRoot = realpathSync(dirname(process.env.GH_FIXTURE_PATH));
if (realpathSync(dirname(process.env.GH_CALL_LOG_PATH)) !== fixtureRoot) {
  throw new Error("Release workflow fake gh log must belong to the same fixture.");
}
const fakeGh = realpathSync(join(fixtureRoot, "bin", "gh"));
const spawnSync = childProcess.spawnSync;
childProcess.spawnSync = function (command, args, options) {
  return command === "gh"
    ? spawnSync(process.execPath, [fakeGh, ...args], options)
    : spawnSync(command, args, options);
};
syncBuiltinESMExports();
