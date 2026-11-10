// FILE: mossManagedHermesProbePlugin.ts
// Purpose: A private, version-scoped Hermes plugin using its installed bounded probe helper.
// Layer: Managed provider configuration; never changes the user's Hermes installation.

export const MOSS_HERMES_PROBE_PLUGIN_NAME = "moss-windows-probe-compat";
/** The managed Hermes compatibility plugin corrects the Windows ACP probe only. */
export function needsManagedHermesProbePlugin(
  platform: NodeJS.Platform = process.platform,
): boolean {
  return platform === "win32";
}

export const MOSS_HERMES_PROBE_HOME_ENV = "MOSS_HERMES_PROBE_COMPAT_HOME";
export const MOSS_HERMES_PROBE_STATUS_PREFIX = "MOSS_HERMES_PROBE_COMPAT_V1:";
export const MOSS_HERMES_PROBE_PLUGIN_MANIFEST = `name: ${MOSS_HERMES_PROBE_PLUGIN_NAME}
version: 1.0.0
description: Moss managed Windows version-probe compatibility
`;

// The exact affected function was observed in the installed Hermes runtime on 2026-11-06.
// Source text is normalized only for indentation/newlines; unfamiliar code is never patched.
export const MOSS_HERMES_PROBE_PLUGIN_SOURCE = String.raw`"""Moss private compatibility. Uses Hermes's runner; no tools or credentials are changed."""
import ast
import hashlib
import inspect
import os
from pathlib import Path
import subprocess
import sys
import textwrap

_AFFECTED_SHA256 = "dbbd57dfe8e1577ddf818bd7be5db75ab91823e024e45f68cdf8021a13b37ae3"
_PREFIX = "MOSS_HERMES_PROBE_COMPAT_V1:"
_OWNER = "moss-windows-probe-compat-v1"


def _status(code):
    # A closed vocabulary: never print exceptions, paths, arguments, env, or child output.
    print(_PREFIX + code, file=sys.stderr, flush=True)


def _source(function):
    return textwrap.dedent(inspect.getsource(function)).replace("\r\n", "\n").strip()


def _direct_bounded_delegate(source, function, helper):
    """Recognize only a direct return of Hermes's helper, not a substring or arbitrary code."""
    try:
        tree = ast.parse(source)
        if len(tree.body) != 1 or not isinstance(tree.body[0], ast.FunctionDef):
            return False
        body = list(tree.body[0].body)
        if body and isinstance(body[0], ast.Expr) and isinstance(body[0].value, ast.Constant) and isinstance(body[0].value.value, str):
            body.pop(0)
        imported = False
        if body and isinstance(body[0], ast.ImportFrom):
            item = body.pop(0)
            imported = item.module == "hermes_cli._subprocess_compat" and len(item.names) == 1 and item.names[0].name == "bounded_probe_run" and item.names[0].asname is None
            if not imported:
                return False
        if len(body) != 1 or not isinstance(body[0], ast.Return):
            return False
        call = body[0].value
        if not isinstance(call, ast.Call) or not isinstance(call.func, ast.Name) or call.func.id != "bounded_probe_run":
            return False
        if not imported and function.__globals__.get("bounded_probe_run") is not helper:
            return False
        # The bounded helper owns cleanup. Require a positive finite literal budget and argv.
        args = tree.body[0].args
        if len(args.args) != 1 or len(call.args) != 1 or not isinstance(call.args[0], ast.Name) or call.args[0].id != args.args[0].arg:
            return False
        timeout = [k.value for k in call.keywords if k.arg == "timeout"]
        if len(timeout) != 1 or not isinstance(timeout[0], ast.Constant) or type(timeout[0].value) not in (int, float) or not 0 < timeout[0].value <= 10:
            return False
        return all(k.arg == "timeout" or (k.arg is None and args.kwarg is not None and isinstance(k.value, ast.Name) and k.value.id == args.kwarg.arg) for k in call.keywords)
    except (TypeError, ValueError, SyntaxError, AttributeError):
        return False


def register(ctx):
    if sys.platform != "win32":
        _status("not-windows")
        return
    try:
        expected = os.environ.get("MOSS_HERMES_PROBE_COMPAT_HOME", "")
        configured = os.environ.get("HERMES_HOME", "")
        if not expected or not configured or not os.environ.get("MOSS_HERMES_CONFIG_CONTENT"):
            _status("wrong-home")
            return
        expected_path = Path(expected).resolve(strict=True)
        # The normal Hermes loader imports this file from the active private home.
        if Path(configured).resolve(strict=True) != expected_path or Path(__file__).resolve().parents[2] != expected_path:
            _status("wrong-home")
            return
        import hermes_constants
        from hermes_cli._subprocess_compat import bounded_probe_run
        if not callable(bounded_probe_run) or not callable(getattr(ctx, "on_unload", None)):
            _status("helper-missing")
            return
        signature = inspect.signature(bounded_probe_run)
        signature.bind(["probe", "--version"], timeout=10, env={}, cwd=None)
        if not {"timeout", "env", "cwd"}.issubset(signature.parameters):
            _status("helper-missing")
            return
        original = hermes_constants._run_version_probe
        if getattr(original, "_moss_probe_owner", None) == _OWNER:
            _status("applied")
            return
        source = _source(original)
        if _direct_bounded_delegate(source, original, bounded_probe_run):
            _status("already-bounded")
            return
        if hashlib.sha256(source.encode("utf-8")).hexdigest() != _AFFECTED_SHA256:
            _status("unknown-implementation")
            return

        def probe(argv, **kwargs):
            result = bounded_probe_run(argv, timeout=10, **kwargs)
            if result is None:
                return None
            # constants._managed_node_tree_outdated still calls stdout.decode().
            return subprocess.CompletedProcess(result.args, result.returncode,
                result.stdout.encode("utf-8"), result.stderr.encode("utf-8"))

        probe._moss_probe_owner = _OWNER

        def restore():
            if hermes_constants._run_version_probe is probe:
                hermes_constants._run_version_probe = original

        # Register cleanup before publishing the change. Never restore over a later owner.
        ctx.on_unload(restore)
        hermes_constants._run_version_probe = probe
        _status("applied")
    except (ImportError, AttributeError, TypeError):
        _status("helper-missing")
    except Exception:
        _status("load-failed")
`;

const statusCodes = [
  "applied",
  "already-bounded",
  "not-windows",
  "wrong-home",
  "helper-missing",
  "unknown-implementation",
  "load-failed",
] as const;
export type MossHermesProbeStatus = (typeof statusCodes)[number];

export function readMossHermesProbeStatus(line: string): MossHermesProbeStatus | undefined {
  if (!line.startsWith(MOSS_HERMES_PROBE_STATUS_PREFIX)) return undefined;
  const status = line.slice(MOSS_HERMES_PROBE_STATUS_PREFIX.length);
  return statusCodes.find((candidate) => candidate === status);
}

export function mossHermesProbeIssue(
  status: MossHermesProbeStatus | undefined,
): string | undefined {
  switch (status) {
    case "applied":
    case "already-bounded":
      return undefined;
    case "unknown-implementation":
      return "Moss could not safely apply compatibility for this Hermes version.";
    case "helper-missing":
      return "This Hermes installation is missing the required compatibility helper.";
    case "wrong-home":
      return "Hermes compatibility did not load from its isolated Moss home.";
    default:
      return "Hermes compatibility did not load. Check whether its Moss plugin is disabled.";
  }
}
