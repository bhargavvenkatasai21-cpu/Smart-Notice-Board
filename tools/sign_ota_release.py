#!/usr/bin/env python3
"""Create a signed manifest for one firmware image using an offline Ed25519 key."""

import argparse
import hashlib
import json
import os
import re
import subprocess
import tempfile
from pathlib import Path


REPOSITORY_ROOT = Path(__file__).resolve().parents[1]
RELEASE_ARTIFACTS_DIR = REPOSITORY_ROOT / "release-artifacts"
SIGNATURE_CONTEXT = "SmartNoticeBoard-OTA-v1\n"
REPOSITORY = "bhargavvenkatasai21-cpu/Smart-Notice-Board"
MAX_FIRMWARE_SIZE = 1_507_328


def parse_arguments(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--firmware", required=True, type=Path)
    parser.add_argument("--version", required=True)
    parser.add_argument("--private-key", required=True, type=Path)
    parser.add_argument(
        "--output",
        type=Path,
        default=Path("release-artifacts/manifest.json"),
    )
    return parser.parse_args(argv)


def build_signed_message(version, size, sha256, firmware_url):
    return (
        f"{SIGNATURE_CONTEXT}{version}\n{size}\n{sha256}\n{firmware_url}"
    ).encode("utf-8")


def _is_relative_to(path, parent):
    try:
        path.relative_to(parent)
    except ValueError:
        return False
    return True


def _validate_version(version):
    if not re.fullmatch(
        r"(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)",
        version,
    ):
        raise ValueError("--version must be a numeric major.minor.patch version.")


def _resolve_firmware(path):
    try:
        firmware = path.resolve(strict=True)
    except OSError as error:
        raise ValueError("The firmware image does not exist.") from error
    if path.is_symlink() or not firmware.is_file():
        raise ValueError("--firmware must identify a regular, non-symlink file.")
    if firmware.stat().st_size == 0:
        raise ValueError("The firmware image is empty.")
    if firmware.stat().st_size > MAX_FIRMWARE_SIZE:
        raise ValueError(
            f"The firmware image exceeds the {MAX_FIRMWARE_SIZE}-byte OTA slot."
        )
    return firmware


def _resolve_private_key(path):
    repository_root = REPOSITORY_ROOT.resolve()
    lexical_path = Path(os.path.abspath(path))
    try:
        private_key = path.resolve(strict=True)
    except OSError as error:
        raise ValueError("The private-key file does not exist.") from error
    if (
        path.is_symlink()
        or not private_key.is_file()
        or _is_relative_to(lexical_path, repository_root)
        or _is_relative_to(private_key, repository_root)
    ):
        raise ValueError("Keep the signing private key outside the repository.")
    return private_key


def _resolve_output(path):
    if RELEASE_ARTIFACTS_DIR.is_symlink():
        raise ValueError("The release-artifacts directory must not be a symlink.")
    RELEASE_ARTIFACTS_DIR.mkdir(parents=True, exist_ok=True)
    release_dir = RELEASE_ARTIFACTS_DIR.resolve(strict=True)
    candidate = Path(os.path.abspath(path))
    if candidate.is_symlink() or candidate.suffix.lower() != ".json":
        raise ValueError("--output must be a new .json file in release-artifacts.")
    if candidate.parent.resolve(strict=False) != release_dir:
        raise ValueError("--output must be directly inside release-artifacts.")
    output = release_dir / candidate.name
    if output.exists() or output.is_symlink():
        raise ValueError("--output already exists; refusing to overwrite it.")
    return output


def _read_firmware(firmware):
    with firmware.open("rb") as image:
        firmware_bytes = image.read(MAX_FIRMWARE_SIZE + 1)
    if len(firmware_bytes) > MAX_FIRMWARE_SIZE:
        raise ValueError(
            f"The firmware image exceeds the {MAX_FIRMWARE_SIZE}-byte OTA slot."
        )
    if not firmware_bytes:
        raise ValueError("The firmware image is empty.")
    return firmware_bytes


def sign_release(firmware_path, version, private_key_path, output_path):
    _validate_version(version)
    firmware = _resolve_firmware(Path(firmware_path))
    private_key = _resolve_private_key(Path(private_key_path))
    output = _resolve_output(Path(output_path))
    firmware_bytes = _read_firmware(firmware)
    size = len(firmware_bytes)
    sha256 = hashlib.sha256(firmware_bytes).hexdigest()
    firmware_url = (
        f"https://github.com/{REPOSITORY}/releases/download/"
        f"v{version}/firmware.bin"
    )
    signed_content = build_signed_message(
        version,
        size,
        sha256,
        firmware_url,
    )

    with tempfile.TemporaryDirectory(prefix="smart-notice-sign-") as directory:
        payload_path = Path(directory) / "signed-content.bin"
        signature_path = Path(directory) / "signature.bin"
        payload_path.write_bytes(signed_content)
        try:
            subprocess.run(
                [
                    "openssl",
                    "pkeyutl",
                    "-sign",
                    "-rawin",
                    "-inkey",
                    str(private_key),
                    "-in",
                    str(payload_path),
                    "-out",
                    str(signature_path),
                ],
                check=True,
                capture_output=True,
                stdin=subprocess.DEVNULL,
            )
        except FileNotFoundError as error:
            raise ValueError("OpenSSL is required to sign the release.") from error
        except subprocess.CalledProcessError as error:
            raise ValueError("OpenSSL could not sign the release.") from error
        try:
            signature = signature_path.read_bytes()
        except OSError as error:
            raise ValueError("OpenSSL did not produce a signature.") from error

    if len(signature) != 64:
        raise ValueError("OpenSSL did not return a 64-byte Ed25519 signature.")

    manifest = {
        "schemaVersion": 1,
        "version": version,
        "firmwareUrl": firmware_url,
        "size": size,
        "sha256": sha256,
        "signature": signature.hex(),
    }
    manifest_bytes = (json.dumps(manifest, indent=2) + "\n").encode("utf-8")
    descriptor = None
    created = False
    try:
        descriptor = os.open(
            output,
            os.O_CREAT | os.O_EXCL | os.O_WRONLY | getattr(os, "O_BINARY", 0),
            0o600,
        )
        created = True
        with os.fdopen(descriptor, "wb") as manifest_file:
            descriptor = None
            manifest_file.write(manifest_bytes)
    except OSError as error:
        if descriptor is not None:
            os.close(descriptor)
        if created:
            output.unlink()
        raise ValueError("Could not safely create the output manifest.") from error

    return output, sha256


def main(argv=None):
    args = parse_arguments(argv)
    try:
        output, sha256 = sign_release(
            args.firmware,
            args.version,
            args.private_key,
            args.output,
        )
    except ValueError as error:
        raise SystemExit(str(error)) from error
    print(f"Signed manifest written to {output}")
    print(f"Firmware SHA-256: {sha256}")


if __name__ == "__main__":
    main()
