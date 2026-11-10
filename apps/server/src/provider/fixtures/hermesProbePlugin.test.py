"""No installed Hermes imports, accounts, subprocesses or network: fake module contract fixtures."""
import contextlib
import importlib.util
import io
import linecache
import os
from pathlib import Path
import subprocess
import sys
import types
import unittest
from unittest.mock import patch

PLUGIN = Path(sys.argv.pop()).resolve()
HOME = PLUGIN.parents[2]
OLD = '''def _run_version_probe(argv: list[str], **kwargs):
    """Run a hidden ``--version`` probe; ``None`` when it cannot run."""
    import subprocess
    try:
        from hermes_cli._subprocess_compat import windows_hide_flags
        return subprocess.run(
            argv, capture_output=True, timeout=10, creationflags=windows_hide_flags(), **kwargs
        )
    except (OSError, subprocess.TimeoutExpired, ValueError):
        return None
'''


class ProbePluginTests(unittest.TestCase):
    def setUp(self):
        spec = importlib.util.spec_from_file_location("moss_probe_fixture", PLUGIN)
        self.plugin = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.plugin)
        self.messages = io.StringIO()
        self.plugin.sys = types.SimpleNamespace(platform="win32", stderr=self.messages)
        self.constants = types.ModuleType("hermes_constants")
        self.set_function(OLD)
        self.original = self.constants._run_version_probe
        self.calls = []
        self.answer = subprocess.CompletedProcess(["probe"], 7, "版本\n", "error")
        def bounded(argv, *, timeout, env=None, cwd=None):
            self.calls.append((argv, timeout, env, cwd))
            return self.answer
        self.helper = types.ModuleType("hermes_cli._subprocess_compat")
        self.helper.bounded_probe_run = bounded
        self.callbacks = []
        self.ctx = types.SimpleNamespace(on_unload=self.callbacks.append)
        self.patch_modules = patch.dict(sys.modules, {"hermes_constants": self.constants, "hermes_cli": types.ModuleType("hermes_cli"), "hermes_cli._subprocess_compat": self.helper})
        self.patch_modules.start()
        self.addCleanup(self.patch_modules.stop)
        self.patch_env = patch.dict(os.environ, {"HERMES_HOME": str(HOME), "MOSS_HERMES_PROBE_COMPAT_HOME": str(HOME), "MOSS_HERMES_CONFIG_CONTENT": "fake-catalog"}, clear=True)
        self.patch_env.start()
        self.addCleanup(self.patch_env.stop)

    def set_function(self, source):
        filename = "<moss-probe-" + self.id() + ">"
        linecache.cache[filename] = (len(source), None, source.splitlines(keepends=True), filename)
        exec(compile(source, filename, "exec"), self.constants.__dict__)

    def status(self, value):
        self.assertEqual(self.messages.getvalue().splitlines()[-1], "MOSS_HERMES_PROBE_COMPAT_V1:" + value)

    def test_affected_bytes_kwargs_returncode(self):
        self.plugin.register(self.ctx)
        self.status("applied")
        result = self.constants._run_version_probe(["probe"], env={"FAKE": "yes"}, cwd="workspace")
        self.assertEqual(result.stdout.decode(), "版本\n")
        self.assertEqual(result.stderr, b"error")
        self.assertEqual(result.returncode, 7)
        self.assertEqual(self.calls, [(["probe"], 10, {"FAKE": "yes"}, "workspace")])
        self.answer = None
        self.assertIsNone(self.constants._run_version_probe(["missing"]))

    def test_idempotence_and_unload(self):
        self.plugin.register(self.ctx)
        first = self.constants._run_version_probe
        self.plugin.register(self.ctx)
        self.assertIs(self.constants._run_version_probe, first)
        self.assertEqual(len(self.callbacks), 1)
        self.callbacks[0]()
        self.assertIs(self.constants._run_version_probe, self.original)

    def test_unload_does_not_replace_later_owner(self):
        self.plugin.register(self.ctx)
        later = lambda argv: None
        self.constants._run_version_probe = later
        self.callbacks[0]()
        self.assertIs(self.constants._run_version_probe, later)

    def test_unknown_never_patches(self):
        self.set_function(OLD.replace("timeout=10", "timeout=11"))
        before = self.constants._run_version_probe
        self.plugin.register(self.ctx)
        self.status("unknown-implementation")
        self.assertIs(self.constants._run_version_probe, before)
        self.assertEqual(self.calls, [])

    def test_direct_fixed_delegate_is_not_patched(self):
        self.set_function('def _run_version_probe(argv, **kwargs):\n    from hermes_cli._subprocess_compat import bounded_probe_run\n    return bounded_probe_run(argv, timeout=10, **kwargs)\n')
        before = self.constants._run_version_probe
        self.plugin.register(self.ctx)
        self.status("already-bounded")
        self.assertIs(self.constants._run_version_probe, before)

    def test_helper_name_in_comment_does_not_claim_fixed(self):
        self.set_function(OLD + "\n# bounded_probe_run\n")
        self.set_function('def _run_version_probe(argv, **kwargs):\n    """bounded_probe_run"""\n    return None\n')
        self.plugin.register(self.ctx)
        self.status("unknown-implementation")

    def test_missing_or_incompatible_helper(self):
        for helper in [None, lambda argv: None]:
            self.helper.bounded_probe_run = helper
            self.plugin.register(self.ctx)
            self.status("helper-missing")
            self.assertIs(self.constants._run_version_probe, self.original)

    def test_wrong_home_and_nonmanaged_are_rejected(self):
        for key, value in [("MOSS_HERMES_CONFIG_CONTENT", ""), ("HERMES_HOME", str(HOME.parent))]:
            with patch.dict(os.environ, {key: value}):
                self.plugin.register(self.ctx)
                self.status("wrong-home")
        self.assertIs(self.constants._run_version_probe, self.original)

    def test_other_platform_is_noop(self):
        self.plugin.sys.platform = "linux"
        self.plugin.register(self.ctx)
        self.status("not-windows")
        self.assertIs(self.constants._run_version_probe, self.original)

    def test_unload_registration_failure_is_visible_and_atomic(self):
        def fail(callback):
            raise RuntimeError("secret detail must stay private")
        self.plugin.register(types.SimpleNamespace(on_unload=fail))
        self.status("load-failed")
        self.assertNotIn("secret", self.messages.getvalue())
        self.assertIs(self.constants._run_version_probe, self.original)


unittest.main()
