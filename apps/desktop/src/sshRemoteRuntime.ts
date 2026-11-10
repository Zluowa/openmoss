// FILE: sshRemoteRuntime.ts
// Purpose: Prepare this exact private Moss payload on a remote POSIX host without a public Moss release.
// Layer: Desktop SSH runtime bootstrap
// Exports: makeSshRemoteRuntimeScript, sshRemoteRuntimeIdentity, SSH_NODE_VERSION, SSH_CODEX_VERSION, SSH_NODE_TARGETS
import { createHash } from "node:crypto";
import desktopPackageJson from "../package.json" with { type: "json" };
import serverPackageJson from "../../server/package.json" with { type: "json" };
import { SSH_REMOTE_PROCESS_RUNNER } from "./sshRemoteProcessRunner";
import { SSH_REMOTE_ARCHIVE_RECEIVER } from "./sshRemoteArchiveReceiver";
import { SSH_REMOTE_RUNTIME_PRUNER } from "./sshRemoteRuntimePruner";
import {
  MOSS_PRODUCTION_PUBLIC_CONFIG_ENV_KEYS,
  MOSS_PUBLIC_MAPS_ENV_KEYS,
} from "@moss/shared/mossProductionPublicConfig";

// Matches the local verification runtime. Targets and SHA256 were checked on
// https://nodejs.org/en/blog/release/v24.19.0 on 2026-11-06.
export const SSH_NODE_VERSION = "24.19.0";
export const SSH_CODEX_VERSION = desktopPackageJson.dependencies["@openai/codex"];
export const SSH_CLAUDE_SDK_VERSION =
  serverPackageJson.dependencies["@anthropic-ai/claude-agent-sdk"];
export const SSH_NODE_TARGETS = {
  "darwin-arm64": "8294b7aa9b03997481c06babf1e8b270c859358f27da57a11509afe537ac381d",
  "darwin-x64": "d1b5e999db158c62fe8f7267a4476b035d8bd93b1a605bac24a3f0dd166e3316",
  "linux-arm64": "d28c8a5bf0a808f0ed434a1dce8c54ae98f0371c0bd86ac58abc613f73e6643f",
  "linux-x64": "f625d97cd707df4ff96254916fbc5ff014f09c09effe5a1e0ca8f6d41a8789d4",
} as const;

export function sshRemoteRuntimeIdentity(payload: Buffer): string {
  const digest = createHash("sha256").update(payload).digest("hex");
  return createHash("sha256")
    .update(`${digest}\n${SSH_NODE_VERSION}\n${SSH_CODEX_VERSION}\n${SSH_CLAUDE_SDK_VERSION}\n2\n`)
    .digest("hex");
}

const shellFunctions = String.raw`
owned_pid=""
owned_alive() {
  [ -n "$owned_pid" ] && kill -0 "$owned_pid" 2>/dev/null || return 1
  if [ -r "/proc/$owned_pid/stat" ]; then
    owner="$(sed 's/.*) //' "/proc/$owned_pid/stat" | awk '{print $2}')"
  else
    owner="$(/bin/ps -p "$owned_pid" -o ppid= 2>/dev/null | tr -d '[:space:]')"
  fi
  [ "$owner" = "$$" ]
}
cancel_bootstrap() {
  code="$1"
  trap - HUP INT TERM PIPE
  if owned_alive; then
    kill -TERM "$owned_pid" 2>/dev/null || true
    for tick in 1 2 3 4 5; do
      if ! owned_alive; then break; fi
      sleep 1
    done
    if owned_alive; then kill -KILL "$owned_pid" 2>/dev/null || true; fi
  fi
  # A child which already exited still needs reaping. Never signal a PID whose
  # parent no longer proves ownership, but wait only uses this shell's job table.
  if [ -n "$owned_pid" ]; then wait "$owned_pid" 2>/dev/null || true; fi
  exit "$code"
}
run_owned() {
  "$@" < /dev/null &
  owned_pid=$!
  while owned_alive; do
    printf 'MOSS_SSH_KEEPALIVE\n' >&3 || cancel_bootstrap 143
    sleep 1
  done
  if wait "$owned_pid"; then result=0; else result=$?; fi
  owned_pid=""
  return "$result"
}
verify_sha256() {
  if command -v sha256sum >/dev/null 2>&1; then
    printf '%s  %s\n' "$1" "$2" | sha256sum -c - >/dev/null
  elif command -v shasum >/dev/null 2>&1; then
    printf '%s  %s\n' "$1" "$2" | shasum -a 256 -c - >/dev/null
  else
    echo MOSS_REMOTE_CHECKSUM_MISSING >&2; return 70
  fi
}
download_https() {
  if command -v curl >/dev/null 2>&1; then run_owned curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 --connect-timeout 15 --max-time 180 "$1" -o "$2"
  elif command -v wget >/dev/null 2>&1; then run_owned wget --https-only --timeout=30 -q "$1" -O "$2"
  else echo MOSS_REMOTE_DOWNLOAD_MISSING >&2; return 70
  fi
}
`;

export function makeSshRemoteRuntimeScript(input: {
  readonly payload: Buffer;
  readonly token: string;
  readonly port: number;
  readonly uploadId?: string;
  readonly publicEnvironment?: Readonly<Record<string, string | undefined>>;
}): string {
  if (
    !/^[a-f0-9]{64}$/u.test(input.token) ||
    !Number.isInteger(input.port) ||
    input.port < 1 ||
    input.port > 65535
  )
    throw new Error("invalid-runtime-input");
  if (input.payload.length === 0 || input.payload.length > 256 * 1024 * 1024)
    throw new Error("runtime-payload");
  const digest = createHash("sha256").update(input.payload).digest("hex");
  if (!/^\d+\.\d+\.\d+$/u.test(SSH_CODEX_VERSION)) throw new Error("invalid-codex-runtime-pin");
  if (!/^\d+\.\d+\.\d+$/u.test(SSH_CLAUDE_SDK_VERSION))
    throw new Error("invalid-claude-runtime-pin");
  const runtimeIdentity = sshRemoteRuntimeIdentity(input.payload);
  if (input.uploadId !== undefined && !/^[a-f0-9-]{36}$/u.test(input.uploadId))
    throw new Error("invalid-runtime-input");
  const publicKeys = new Set<string>([
    ...MOSS_PRODUCTION_PUBLIC_CONFIG_ENV_KEYS,
    ...MOSS_PUBLIC_MAPS_ENV_KEYS,
  ]);
  const publicExports = Object.entries(input.publicEnvironment ?? {})
    .flatMap(([key, value]) => {
      if (value === undefined) return [];
      if (!publicKeys.has(key) || value.length > 16384 || /[\r\n\0]/u.test(value))
        throw new Error("invalid-public-runtime-environment");
      return [`export ${key}='${value.replaceAll("'", "'\"'\"'")}'`];
    })
    .join("\n");
  const targets = Object.entries(SSH_NODE_TARGETS)
    .map(([target, hash]) => `  ${target}) expected='${hash}' ;;`)
    .join("\n");
  const continuation = `set -eu
runtime_root="$MOSS_SSH_RUNTIME_ROOT"
prepare="$MOSS_SSH_PREPARE_DIR"
payload_dir="$MOSS_SSH_PAYLOAD_DIR"
export MOSS_SSH_RUNNER_CLEANUP=0
${shellFunctions}
trap 'cancel_bootstrap 129' HUP
trap 'cancel_bootstrap 130' INT
trap 'cancel_bootstrap 143' TERM
trap 'cancel_bootstrap 141' PIPE
if [ ! -f "$payload_dir/.dependencies-ready" ]; then
  verify_sha256 '${digest}' "$MOSS_SSH_ARCHIVE_PATH" || { echo MOSS_REMOTE_CHECKSUM_FAILED >&3; exit 72; }
  mkdir "$prepare/package"
  run_owned tar -xzf "$MOSS_SSH_ARCHIVE_PATH" -C "$prepare/package"
  cd "$prepare/package"
  export npm_config_cache="$runtime_root/npm-cache"
  export npm_config_devdir="$runtime_root/node-gyp-cache"
  # Match the existing Bun graph: OpenCode's optional Effect peer differs from
  # the repository's fixed Effect build. This flag is private to this install.
  # The SDK's native CLIs are optional, large downloads. Keep the JS SDK and
  # all required dependencies (including node-pty and its install scripts).
  # The verified archive carries npm-shrinkwrap.json: every package is pinned to
  # the exact release and integrity this Moss build was tested with. npm ci never
  # resolves a newer upstream release and fails if the lock and manifest disagree.
  [ -f npm-shrinkwrap.json ] || { echo MOSS_REMOTE_RUNTIME_INSTALL_FAILED >&3; exit 73; }
  run_owned node "$prepare/process-runner.cjs" npm ci --omit=dev --no-audit --no-fund --legacy-peer-deps --omit=optional > "$prepare/install.log" 2>&1 || { echo MOSS_REMOTE_RUNTIME_INSTALL_FAILED >&3; exit 73; }
  run_owned node "$prepare/process-runner.cjs" node dist/runtimeDependencySmoke.mjs > "$prepare/runtime-smoke.log" 2>&1 || { echo MOSS_REMOTE_NATIVE_PREPARE_FAILED >&3; exit 74; }
  printf '%s\\n' '${runtimeIdentity}' > .dependencies-ready
  if [ ! -d "$payload_dir" ]; then mv "$prepare/package" "$payload_dir"; fi
fi
cd "$payload_dir"
# Superseded runtimes and finished uploads are removed only when no process uses
# them and they have been idle for a day. Cleanup never blocks this connection.
run_owned node "$prepare/runtime-pruner.cjs" > /dev/null 2>&1 || true
export npm_config_cache="$runtime_root/npm-cache"
export npm_config_devdir="$runtime_root/node-gyp-cache"
echo MOSS_SSH_PROGRESS_AGENTS >&3
is_usable_cli() {
  node -e 'const {spawnSync}=require("node:child_process"); const r=spawnSync(process.argv[1],["--version"],{timeout:10000,encoding:"utf8",stdio:["ignore","pipe","ignore"]}); const v=/\\b(\\d+\\.\\d+\\.\\d+)\\b/.exec(r.stdout||"")?.[1]; process.exit(r.status===0&&v&&(!process.argv[2]||v===process.argv[2])?0:1)' "$1" "\$\{2:-\}"
}
existing_codex="$(command -v codex || true)"
existing_claude="$(command -v claude || true)"
need_codex=1
need_claude=1
if [ -n "$existing_codex" ] && is_usable_cli "$existing_codex"; then need_codex=0; fi
if [ -n "$existing_claude" ] && is_usable_cli "$existing_claude"; then need_claude=0; fi
native_target="$(node -p 'process.platform + "-" + process.arch')"
case "$native_target" in linux-x64|linux-arm64|darwin-x64|darwin-arm64|win32-x64|win32-arm64) ;; *) echo MOSS_REMOTE_PLATFORM_UNSUPPORTED >&2; exit 70 ;; esac
claude_target="$native_target"
if [ "$(node -p 'process.platform === "linux" && !process.report.getReport().header.glibcVersionRuntime ? "musl" : "glibc"')" = musl ]; then claude_target="$native_target-musl"; fi
claude_code_version="$(node -e 'const m=require("./node_modules/@anthropic-ai/claude-agent-sdk/package.json"); if(m.version!=="${SSH_CLAUDE_SDK_VERSION}"||!/^\\d+\\.\\d+\\.\\d+$/.test(m.claudeCodeVersion))process.exit(1);process.stdout.write(m.claudeCodeVersion)')" || { echo MOSS_REMOTE_AGENT_PREPARE_FAILED >&2; exit 75; }
claude_bundle="$payload_dir/node_modules/@anthropic-ai/claude-agent-sdk-$claude_target/claude"
case "$native_target" in win32-*) claude_bundle="$claude_bundle.exe" ;; esac
agent_install=0
set --
if [ "$need_codex" = 1 ]; then
  set -- "$@" '@openai/codex@${SSH_CODEX_VERSION}' "@openai/codex-$native_target@npm:@openai/codex@${SSH_CODEX_VERSION}-$native_target"
  if ! node node_modules/@openai/codex/bin/codex.js --version > "$prepare/codex-version" 2>/dev/null || ! tr -d '\\r' < "$prepare/codex-version" | grep -Fx 'codex-cli ${SSH_CODEX_VERSION}' >/dev/null; then agent_install=1; fi
fi
if [ "$need_claude" = 1 ]; then
  set -- "$@" "@anthropic-ai/claude-agent-sdk-$claude_target@${SSH_CLAUDE_SDK_VERSION}"
  if ! is_usable_cli "$claude_bundle" "$claude_code_version"; then agent_install=1; fi
fi
if [ "$agent_install" = 1 ]; then
  # Install all required private fallbacks together: separate no-save installs
  # can prune the other agent's explicitly selected native package.
  run_owned node "$prepare/process-runner.cjs" npm install --no-save --omit=dev --no-audit --no-fund --legacy-peer-deps --omit=optional "$@" > "$prepare/agent-install.log" 2>&1 || { echo MOSS_REMOTE_AGENT_PREPARE_FAILED >&3; exit 75; }
  run_owned node "$prepare/process-runner.cjs" node dist/runtimeDependencySmoke.mjs > "$prepare/runtime-smoke.log" 2>&1 || { echo MOSS_REMOTE_NATIVE_PREPARE_FAILED >&3; exit 74; }
fi
if [ "$need_codex" = 1 ]; then
  node node_modules/@openai/codex/bin/codex.js --version > "$prepare/codex-version" 2>/dev/null && tr -d '\\r' < "$prepare/codex-version" | grep -Fx 'codex-cli ${SSH_CODEX_VERSION}' >/dev/null || { echo MOSS_REMOTE_AGENT_PREPARE_FAILED >&2; exit 75; }
  export MOSS_BUNDLED_CODEX_PATH="$payload_dir/node_modules/.bin/codex"
else export MOSS_BUNDLED_CODEX_PATH="$existing_codex"; fi
if [ "$need_claude" = 1 ]; then
  is_usable_cli "$claude_bundle" "$claude_code_version" || { echo MOSS_REMOTE_AGENT_PREPARE_FAILED >&2; exit 75; }
  export MOSS_BUNDLED_CLAUDE_PATH="$claude_bundle"
else export MOSS_BUNDLED_CLAUDE_PATH="$existing_claude"; fi
echo MOSS_SSH_PROGRESS_STARTING >&3
exec node dist/index.mjs --host 127.0.0.1 --port ${input.port} --no-browser
`;
  return `set -eu
umask 077
exec 3>&2
runtime_root="$HOME/.moss/ssh-runtime"
mkdir -p "$runtime_root"
${shellFunctions}
prepare="$(mktemp -d "$runtime_root/.prepare.XXXXXXXX")"
cleanup() {
  case "$prepare" in "$runtime_root"/.prepare.*) rm -rf -- "$prepare" ;; esac
}
trap cleanup EXIT
trap 'cancel_bootstrap 129' HUP
trap 'cancel_bootstrap 130' INT
trap 'cancel_bootstrap 143' TERM
trap 'cancel_bootstrap 141' PIPE
echo MOSS_SSH_PROGRESS_RUNTIME >&3
export MOSS_SSH_RUNNER_CLEANUP=0
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
if ! command -v node >/dev/null 2>&1 || ! node -e 'const [major,minor]=process.versions.node.split(".").map(Number);process.exit(major>24||(major===24&&minor>=19)?0:1)' >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
  case "$(uname -s)" in Linux) os=linux ;; Darwin) os=darwin ;; *) echo MOSS_REMOTE_PLATFORM_UNSUPPORTED >&2; exit 70 ;; esac
  case "$(uname -m)" in x86_64|amd64) arch=x64 ;; arm64|aarch64) arch=arm64 ;; *) echo MOSS_REMOTE_PLATFORM_UNSUPPORTED >&2; exit 70 ;; esac
  target="$os-$arch"
  case "$target" in
${targets}
    *) echo MOSS_REMOTE_PLATFORM_UNSUPPORTED >&2; exit 70 ;;
  esac
  node_dir="node-v${SSH_NODE_VERSION}-$target"
  if [ ! -x "$runtime_root/$node_dir/bin/node" ]; then
    download_https "https://nodejs.org/dist/v${SSH_NODE_VERSION}/$node_dir.tar.gz" "$prepare/node.tar.gz" || { echo MOSS_REMOTE_RUNTIME_INSTALL_FAILED >&2; exit 71; }
    verify_sha256 "$expected" "$prepare/node.tar.gz" || { echo MOSS_REMOTE_CHECKSUM_FAILED >&2; exit 72; }
    run_owned tar -xzf "$prepare/node.tar.gz" -C "$prepare"
    if [ ! -d "$runtime_root/$node_dir" ]; then mv "$prepare/$node_dir" "$runtime_root/$node_dir"; fi
  fi
  export PATH="$runtime_root/$node_dir/bin:$PATH"
fi
native_key="$(node -p 'process.platform + "-" + process.arch + "-" + process.versions.modules')"
cat > "$prepare/process-runner.cjs" <<'MOSS_PROCESS_RUNNER_EOF'
${SSH_REMOTE_PROCESS_RUNNER}
MOSS_PROCESS_RUNNER_EOF
payload_dir="$runtime_root/payload-${runtimeIdentity}-$native_key"
cat > "$prepare/continue.sh" <<'MOSS_INSTALL_CONTINUATION_EOF'
${continuation}
MOSS_INSTALL_CONTINUATION_EOF
cat > "$prepare/payload-receiver.cjs" <<'MOSS_ARCHIVE_RECEIVER_EOF'
${SSH_REMOTE_ARCHIVE_RECEIVER}
MOSS_ARCHIVE_RECEIVER_EOF
cat > "$prepare/runtime-pruner.cjs" <<'MOSS_RUNTIME_PRUNER_EOF'
${SSH_REMOTE_RUNTIME_PRUNER}
MOSS_RUNTIME_PRUNER_EOF
${publicExports}
export MOSS_AUTH_TOKEN='${input.token}'
export MOSS_HOME="$HOME/.moss/ssh-workspaces/${input.uploadId ?? "default"}"
export MOSS_DISABLE_AUTH_PROTOCOL_REGISTRATION=1
export MOSS_DISABLE_SHORTCUT_ICON_SYNC=1
export MOSS_MODE=web
export MOSS_SSH_RUNTIME_ROOT="$runtime_root"
export MOSS_SSH_PREPARE_DIR="$prepare"
export MOSS_SSH_PAYLOAD_DIR="$payload_dir"
export MOSS_SSH_ARCHIVE_SHA256='${digest}'
export MOSS_SSH_ARCHIVE_BYTES='${input.payload.length}'
export MOSS_SSH_UPLOAD_ID='${input.uploadId ?? "default"}'
export MOSS_SSH_CHILD_STDIN=1
export MOSS_SSH_RUNNER_CLEANUP=1
trap - EXIT HUP INT TERM PIPE
exec node "$prepare/process-runner.cjs" node "$prepare/payload-receiver.cjs" # MOSS_SSH_BOOTSTRAP_HEADER_END
`;
}
