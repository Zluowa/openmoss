import path from "node:path";
import type { RepairRunnerConfig } from "./devsRepairRunner";

export function readDevsRepairConfig(env: NodeJS.ProcessEnv = process.env) {
  const required = (name: string) => {
    const value = env[name]?.trim();
    if (!value) throw new Error(`Missing ${name}.`);
    return value;
  };
  const root = path.resolve(required("MOSS_DEVS_STATE_DIR"));
  const execution = env.MOSS_DEVS_EXECUTION ?? "docker";
  if (!["docker", "local-codex"].includes(execution))
    throw new Error("Invalid repair execution mode.");
  const localCodex =
    execution === "local-codex"
      ? {
          executable: required("MOSS_DEVS_CODEX_PATH"),
          model: required("MOSS_DEVS_MAGPIE_MODEL"),
          magpieUrl: env.MOSS_DEVS_MAGPIE_URL ?? "http://127.0.0.1:3425",
          ...(env.MOSS_DEVS_MAGPIE_CLAUDE_MODEL
            ? { claudeModel: env.MOSS_DEVS_MAGPIE_CLAUDE_MODEL }
            : {}),
        }
      : undefined;
  const claudeKey = env.ANTHROPIC_API_KEY;
  const codexKey = env.CODEX_API_KEY;
  if (!localCodex && !claudeKey && !codexKey)
    throw new Error("Configure at least one team executor key.");
  const config: RepairRunnerConfig = {
    repository: required("MOSS_DEVS_REPOSITORY"),
    mirrorDir: path.resolve(required("MOSS_DEVS_MIRROR_DIR")),
    workDir: path.resolve(env.MOSS_DEVS_WORK_DIR ?? path.join(root, "jobs")),
    image: env.MOSS_DEVS_IMAGE ?? "moss-devs-agent:local",
    githubToken: required("MOSS_DEVS_GITHUB_TOKEN"),
    ...(claudeKey ? { claudeKey } : {}),
    ...(codexKey ? { codexKey } : {}),
    ...(localCodex ? { localCodex, githubVerifyRef: env.MOSS_DEVS_VERIFY_REF ?? "main" } : {}),
    verify: [
      ["bun", "run", "fmt:check"],
      ["bun", "run", "lint"],
      ["bun", "run", "typecheck"],
      ["bun", "run", "test"],
    ],
  };
  const engines: readonly ("claude" | "codex")[] = localCodex
    ? [...(localCodex.claudeModel ? ["claude" as const] : []), "codex"]
    : [...(claudeKey ? ["claude" as const] : []), ...(codexKey ? ["codex" as const] : [])];
  return { root, config, engines, required };
}
