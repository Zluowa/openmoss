#!/usr/bin/env bash
# Run the CN matrix. On macOS this defaults to one sequential Moss.app process;
# explicitly opt into workers only on a platform with scoped Electron locks.
set -euo pipefail

# macOS Electron enforces one instance per application bundle.  Keep the
# default as a sequential full-matrix run; callers on a platform with scoped
# Electron locks may opt into the old multi-worker mode explicitly.
WORKERS="${MOSS_CN_MATRIX_WORKERS:-1}"
BASE_CDP_PORT="${MOSS_CN_MATRIX_BASE_CDP_PORT:-9230}"
CLEAN_PATH="${MOSS_CN_MATRIX_PATH:-/Users/moss/.local/bin:/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:/Users/moss/.bun/bin}"
MOSS_APP="${MOSS_CN_MATRIX_MOSS_APP:-/Applications/Moss.app/Contents/MacOS/Moss}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER="${SCRIPT_DIR}/moss-cn-managed-matrix-ui-e2e.mjs"
LOG_DIR="${MOSS_CN_MATRIX_LOG_DIR:-/tmp/moss-cn-matrix-workers}"
REPORT_DIR="${MOSS_CN_MATRIX_REPORT_DIR:-/tmp}"
# On platforms with scoped Electron locks, these paths can be cloned per
# worker. macOS still owns a bundle-wide lock, so the default is one sequential
# app process and profile cloning is opt-in for isolated environments.
PROFILE_ROOT="${MOSS_CN_MATRIX_PROFILE_ROOT:-/tmp/moss-cn-matrix-profiles}"
BASE_MOSS_HOME="${MOSS_CN_MATRIX_BASE_MOSS_HOME:-${HOME}/.moss}"
BASE_ELECTRON_PROFILE="${MOSS_CN_MATRIX_BASE_ELECTRON_PROFILE:-${HOME}/Library/Application Support/moss}"
REPORT_PREFIX="${REPORT_DIR%/}/moss-cn-matrix-report"
CASE_FILTER="${MOSS_CN_MATRIX_FILTER:-}"
CLONE_PROFILES="${MOSS_CN_MATRIX_CLONE_PROFILES:-0}"
FORCE_RESTART="${MOSS_CN_MATRIX_FORCE_RESTART:-1}"

if [[ "$WORKERS" -gt 1 && "$(uname -s)" == "Darwin" ]]; then
  echo "Moss uses a macOS-wide single-instance lock; run with MOSS_CN_MATRIX_WORKERS=1 for a real matrix." >&2
  exit 2
fi

if [[ "$FORCE_RESTART" == "1" ]]; then
  # Avoid forwarding the launch to an older Moss process that owns the bundle
  # lock.  This is deliberately limited to the exact configured Moss binary.
  pkill -TERM -f "$MOSS_APP" 2>/dev/null || true
  for _ in $(seq 1 30); do
    pgrep -f "$MOSS_APP" >/dev/null 2>&1 || break
    sleep 1
  done
  pkill -KILL -f "$MOSS_APP" 2>/dev/null || true
fi

mkdir -p "$LOG_DIR" "$PROFILE_ROOT" "$REPORT_DIR"
pids=()
app_pids=()
cleanup() {
  for pid in "${app_pids[@]:-}"; do
    kill "$pid" 2>/dev/null || true
  done
}
trap cleanup EXIT INT TERM

clone_profile() {
  local source="$1"
  local target="$2"
  mkdir -p "$target"
  if [[ -d "$source" ]]; then
    # ditto preserves Keychain-compatible Chromium cookie files on macOS.
    # Do not copy process locks or the CDP marker from the source profile.
    /usr/bin/ditto "$source" "$target"
    find "$target" -type f \( -name 'LOCK' -o -name 'Singleton*' -o -name 'DevToolsActivePort' \) -delete 2>/dev/null || true
  fi
}

for ((i = 0; i < WORKERS; i++)); do
  port=$((BASE_CDP_PORT + i))
  cdp="http://127.0.0.1:${port}"
  if [[ "$CLONE_PROFILES" == "1" ]]; then
    worker_root="${PROFILE_ROOT}/worker-${i}"
    worker_home="${worker_root}/moss-home"
    worker_electron_profile="${worker_root}/electron-user-data"
    if [[ -d "$worker_root" ]]; then
      find "$worker_root" -depth -delete
    fi
    clone_profile "$BASE_MOSS_HOME" "$worker_home"
    clone_profile "$BASE_ELECTRON_PROFILE" "$worker_electron_profile"
  else
    worker_home="$BASE_MOSS_HOME"
    worker_electron_profile="$BASE_ELECTRON_PROFILE"
  fi
  if ! curl -sS --noproxy '*' --max-time 2 "${cdp}/json/version" >/dev/null 2>&1; then
    nohup env -i HOME="${HOME}" USER="${USER}" PATH="${CLEAN_PATH}" LANG="${LANG:-zh_CN.UTF-8}" \
      MOSS_HOME="${worker_home}" MOSS_DESKTOP_USER_DATA_DIR="${worker_electron_profile}" \
      "${MOSS_APP}" \
      --remote-debugging-address=127.0.0.1 --remote-debugging-port="${port}" \
      >> "${LOG_DIR}/moss-${port}.log" 2>&1 &
    app_pids+=("$!")
    ready=0
    for _ in $(seq 1 90); do
      if curl -sS --noproxy '*' --max-time 2 "${cdp}/json/version" >/dev/null 2>&1; then
        ready=1
        break
      fi
      sleep 1
    done
    if [[ "$ready" != 1 ]]; then
      echo "worker ${i}: Moss did not expose CDP at ${cdp}" >&2
      exit 1
    fi
  fi
  env -i HOME="${HOME}" USER="${USER}" PATH="${CLEAN_PATH}" LANG="${LANG:-zh_CN.UTF-8}" \
    MOSS_HOME="${worker_home}" MOSS_DESKTOP_USER_DATA_DIR="${worker_electron_profile}" \
    MOSS_PHONE_E2E_CDP_URL="${cdp}" \
    MOSS_CN_MATRIX_SHARD_INDEX="${i}" \
    MOSS_CN_MATRIX_SHARD_COUNT="${WORKERS}" \
    MOSS_CN_MATRIX_WORKER_TAG="${i}" \
    MOSS_CN_MATRIX_FILTER="${CASE_FILTER}" \
    MOSS_CN_MATRIX_REPORT="${REPORT_PREFIX}-${i}.json" \
    node "${RUNNER}" \
    > "${LOG_DIR}/worker-${i}.log" 2>&1 &
  pid=$!
  pids+=("${pid}")
  echo "worker ${i}: cdp=${cdp} pid=${pid}"
done

fail=0
for pid in "${pids[@]}"; do
  if ! wait "${pid}"; then fail=1; fi
done

python3 - <<'PY' "${WORKERS}" "${REPORT_PREFIX}" || exit 1
import json, sys
workers = int(sys.argv[1])
report_prefix = sys.argv[2]
merged = {"ok": True, "total": 0, "passed": 0, "failed": 0, "workers": [], "results": []}
for i in range(workers):
    path = f"{report_prefix}-{i}.json"
    try:
        report = json.load(open(path))
    except OSError:
        merged["ok"] = False
        merged["workers"].append({"worker": i, "error": "missing report"})
        continue
    merged["workers"].append({"worker": i, "cdpUrl": report.get("cdpUrl"), "ok": report.get("ok")})
    merged["total"] += report.get("total", 0)
    merged["passed"] += report.get("passed", 0)
    merged["failed"] += report.get("failed", 0)
    merged["results"].extend(report.get("results", []))
    if not report.get("ok"):
        merged["ok"] = False
from datetime import datetime, timezone
merged["finishedAt"] = datetime.now(timezone.utc).isoformat()
json.dump(merged, open(f"{report_prefix}.json", "w"), indent=2)
print(json.dumps({"ok": merged["ok"], "passed": merged["passed"], "failed": merged["failed"], "total": merged["total"]}))
PY

exit "${fail}"
