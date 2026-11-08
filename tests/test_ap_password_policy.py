import builtins
import shutil
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from tools.ap_password_policy import (
    has_valid_board_ap_password,
    has_valid_board_ap_password_file,
    is_valid_ap_password,
)


class ApPasswordPolicyTests(unittest.TestCase):
    def _run_upload_hook(self, project_directory, targets):
        script = (
            Path(__file__).resolve().parents[1]
            / "tools"
            / "require_ap_password.py"
        )
        namespace = {
            "__builtins__": builtins,
            "COMMAND_LINE_TARGETS": targets,
        }

        class FakeEnvironment:
            def subst(self, variable):
                if variable != "$PROJECT_DIR":
                    raise AssertionError("Unexpected SCons environment variable.")
                return str(project_directory)

        def import_scons_variable(name):
            if name != "env":
                raise AssertionError("Unexpected SCons variable import.")
            namespace["env"] = FakeEnvironment()

        namespace["Import"] = import_scons_variable
        previous_module = sys.modules.pop("ap_password_policy", None)
        try:
            with patch.object(
                sys,
                "path",
                [str(project_directory / "tools"), *sys.path],
            ):
                exec(
                    compile(script.read_text(encoding="utf-8"), str(script), "exec"),
                    namespace,
                )
        finally:
            sys.modules.pop("ap_password_policy", None)
            if previous_module is not None:
                sys.modules["ap_password_policy"] = previous_module

    def test_platformio_upload_hook_requires_custom_password(self):
        with tempfile.TemporaryDirectory() as temporary_directory:
            project_directory = Path(temporary_directory)
            (project_directory / "tools").mkdir()
            (project_directory / "include").mkdir()
            source_policy = (
                Path(__file__).resolve().parents[1]
                / "tools"
                / "ap_password_policy.py"
            )
            shutil.copyfile(
                source_policy,
                project_directory / "tools" / "ap_password_policy.py",
            )

            self._run_upload_hook(project_directory, ["buildprog"])
            with self.assertRaisesRegex(RuntimeError, "upload blocked"):
                self._run_upload_hook(project_directory, ["upload"])

            secrets_file = project_directory / "include" / "secrets.h"
            secrets_file.write_text(
                '#define BOARD_AP_PASSWORD "12345678"\n',
                encoding="utf-8",
            )
            with self.assertRaisesRegex(RuntimeError, "upload blocked"):
                self._run_upload_hook(project_directory, ["upload"])

            secrets_file.write_text(
                '#define BOARD_AP_PASSWORD "Board-Setup-Password-42"\n',
                encoding="utf-8",
            )
            self._run_upload_hook(project_directory, ["upload"])

    def test_accepts_a_custom_valid_password(self):
        self.assertTrue(is_valid_ap_password("Board-Setup-Password-42"))

    def test_rejects_legacy_default_and_example_placeholder(self):
        self.assertFalse(is_valid_ap_password("12345678"))
        self.assertFalse(
            is_valid_ap_password(
                "replace-with-a-unique-8-to-63-character-password"
            )
        )

    def test_enforces_wifi_password_length(self):
        self.assertFalse(is_valid_ap_password("short"))
        self.assertFalse(is_valid_ap_password("x" * 64))

    def test_requires_exactly_one_valid_header_definition(self):
        self.assertTrue(
            has_valid_board_ap_password(
                '#define BOARD_AP_PASSWORD "Board-Setup-Password-42"\n'
            )
        )
        self.assertFalse(has_valid_board_ap_password(""))
        self.assertFalse(
            has_valid_board_ap_password(
                '#define BOARD_AP_PASSWORD "12345678"\n'
            )
        )
        self.assertFalse(
            has_valid_board_ap_password(
                '#define BOARD_AP_PASSWORD "valid-password-123"\n'
                '#define BOARD_AP_PASSWORD "another-password-456"\n'
            )
        )

    def test_password_file_gate_rejects_missing_or_default_configuration(self):
        with tempfile.TemporaryDirectory() as temporary_directory:
            secrets_file = Path(temporary_directory) / "secrets.h"
            self.assertFalse(has_valid_board_ap_password_file(secrets_file))

            secrets_file.write_text(
                '#define BOARD_AP_PASSWORD "12345678"\n',
                encoding="utf-8",
            )
            self.assertFalse(has_valid_board_ap_password_file(secrets_file))

            secrets_file.write_text(
                '#define BOARD_AP_PASSWORD "Board-Setup-Password-42"\n',
                encoding="utf-8",
            )
            self.assertTrue(has_valid_board_ap_password_file(secrets_file))


if __name__ == "__main__":
    unittest.main()
