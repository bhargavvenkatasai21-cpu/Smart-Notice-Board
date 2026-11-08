"""Prevent PlatformIO firmware uploads without a non-default AP password."""

from pathlib import Path
import sys


# The SCons host injects these names when it evaluates an extra script.
Import("env")  # type: ignore[reportUndefinedVariable]
project_directory = Path(env.subst("$PROJECT_DIR"))  # type: ignore[reportUndefinedVariable]
sys.path.insert(0, str(project_directory / "tools"))
from ap_password_policy import has_valid_board_ap_password_file


if {"upload", "uploadfs"} & {
    str(target).lower() for target in COMMAND_LINE_TARGETS  # type: ignore[reportUndefinedVariable]
}:
    secrets_file = project_directory / "include" / "secrets.h"
    if not has_valid_board_ap_password_file(secrets_file):
        raise RuntimeError(
            "Firmware upload blocked: configure BOARD_AP_PASSWORD in "
            "the ignored include/secrets.h with a custom non-default password."
        )
