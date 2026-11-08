"""Validation helpers for the ESP32 setup access-point password."""

import re
from pathlib import Path


def is_valid_ap_password(password):
    try:
        password_bytes = password.encode("utf-8")
    except UnicodeEncodeError:
        return False
    if not 8 <= len(password_bytes) <= 63:
        return False
    if password == "12345678" or password.startswith("replace-with-"):
        return False
    return not any(character in password for character in "\r\n\0")


def has_valid_board_ap_password(secrets_contents):
    matches = re.findall(
        r'^\s*#\s*define\s+BOARD_AP_PASSWORD\s+"([^"\r\n]*)"\s*$',
        secrets_contents,
        flags=re.MULTILINE,
    )
    return len(matches) == 1 and is_valid_ap_password(matches[0])


def has_valid_board_ap_password_file(path):
    secrets_file = Path(path)
    if not secrets_file.is_file():
        return False
    try:
        secrets_contents = secrets_file.read_text(encoding="utf-8")
    except (OSError, UnicodeError):
        return False
    return has_valid_board_ap_password(secrets_contents)
