"""Inject a validated release version without editing firmware source."""

import os
import re


Import("env")  # type: ignore[reportUndefinedVariable]
version = os.environ.get("BOARD_FIRMWARE_VERSION", "1.0.3")
if not re.fullmatch(
    r"(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)",
    version,
):
    raise RuntimeError(
        "BOARD_FIRMWARE_VERSION must be a numeric major.minor.patch version."
    )

env.Append(  # type: ignore[reportUndefinedVariable]
    CPPDEFINES=[("BOARD_FIRMWARE_VERSION", f'\\"{version}\\"')]
)
