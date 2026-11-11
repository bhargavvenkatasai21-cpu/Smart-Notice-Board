import hashlib
import json
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from tools import sign_ota_release


class SignOtaReleaseTests(unittest.TestCase):
    def setUp(self):
        self.temporary_directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary_directory.cleanup)
        self.root = Path(self.temporary_directory.name)
        self.repository = self.root / "repository"
        self.repository.mkdir()
        self.release_directory = self.repository / "release-artifacts"
        self.release_directory.mkdir()
        self.firmware = self.repository / "firmware.bin"
        self.firmware.write_bytes(b"test firmware")
        self.private_key = self.root / "offline-private-key.pem"
        self.private_key.write_text("test-only placeholder, not a key")
        self.output = self.release_directory / "manifest.json"
        self.root_patches = (
            patch.object(sign_ota_release, "REPOSITORY_ROOT", self.repository),
            patch.object(
                sign_ota_release,
                "RELEASE_ARTIFACTS_DIR",
                self.release_directory,
            ),
        )
        for root_patch in self.root_patches:
            root_patch.start()
            self.addCleanup(root_patch.stop)

    def _fake_openssl(self, expected_message):
        def fake_run(arguments, **kwargs):
            payload_path = Path(arguments[arguments.index("-in") + 1])
            signature_path = Path(arguments[arguments.index("-out") + 1])
            self.assertEqual(payload_path.read_bytes(), expected_message)
            self.assertEqual(arguments[arguments.index("-inkey") + 1], str(self.private_key))
            self.assertIs(kwargs["stdin"], subprocess.DEVNULL)
            signature_path.write_bytes(bytes(range(64)))

        return fake_run

    def test_signing_uses_canonical_payload_and_writes_manifest(self):
        firmware_bytes = self.firmware.read_bytes()
        digest = hashlib.sha256(firmware_bytes).hexdigest()
        url = (
            "https://github.com/bhargavvenkatasai21-cpu/Smart-Notice-Board/"
            "releases/download/v1.2.3/firmware.bin"
        )
        expected_message = (
            f"SmartNoticeBoard-OTA-v1\n1.2.3\n{len(firmware_bytes)}\n"
            f"{digest}\n{url}"
        ).encode("utf-8")
        firmware_source = (
            Path(__file__).resolve().parents[1] / "src" / "firmware_update.cpp"
        ).read_text(encoding="utf-8")
        self.assertIn(
            'constexpr char kSignatureContext[] = "SmartNoticeBoard-OTA-v1\\n";',
            firmware_source,
        )
        self.assertIn(
            'manifestVersion + "\\n" +',
            firmware_source,
        )
        self.assertIn(
            'hashHex + "\\n" + firmwareUrl',
            firmware_source,
        )

        with patch(
            "tools.sign_ota_release.subprocess.run",
            side_effect=self._fake_openssl(expected_message),
        ) as run:
            output, returned_digest = sign_ota_release.sign_release(
                self.firmware,
                "1.2.3",
                self.private_key,
                self.output,
                "v1.2.3",
            )

        manifest = json.loads(output.read_text(encoding="utf-8"))
        self.assertEqual(returned_digest, digest)
        self.assertEqual(manifest["version"], "1.2.3")
        self.assertEqual(manifest["size"], len(firmware_bytes))
        self.assertEqual(manifest["sha256"], digest)
        self.assertEqual(manifest["firmwareUrl"], url)
        self.assertEqual(manifest["signature"], bytes(range(64)).hex())
        run.assert_called_once()

    def test_firmware_larger_than_ota_slot_is_rejected_before_signing(self):
        self.firmware.write_bytes(
            b"x" * (sign_ota_release.MAX_FIRMWARE_SIZE + 1)
        )
        with patch("tools.sign_ota_release.subprocess.run") as run:
            with self.assertRaisesRegex(ValueError, "exceeds"):
                sign_ota_release.sign_release(
                    self.firmware,
                    "1.2.3",
                    self.private_key,
                    self.output,
                    "v1.2.3",
                )
        run.assert_not_called()
        self.assertFalse(self.output.exists())

    def test_firmware_at_ota_slot_limit_is_accepted(self):
        self.firmware.write_bytes(b"x" * sign_ota_release.MAX_FIRMWARE_SIZE)
        firmware_bytes = self.firmware.read_bytes()
        digest = hashlib.sha256(firmware_bytes).hexdigest()
        url = (
            "https://github.com/bhargavvenkatasai21-cpu/Smart-Notice-Board/"
            "releases/download/v1.2.3/firmware.bin"
        )
        expected_message = (
            f"SmartNoticeBoard-OTA-v1\n1.2.3\n{len(firmware_bytes)}\n"
            f"{digest}\n{url}"
        ).encode("utf-8")
        with patch(
            "tools.sign_ota_release.subprocess.run",
            side_effect=self._fake_openssl(expected_message),
        ):
            output, _ = sign_ota_release.sign_release(
                self.firmware,
                "1.2.3",
                self.private_key,
                self.output,
                "v1.2.3",
            )
        self.assertEqual(json.loads(output.read_text())["size"], 1_507_328)

    def test_invalid_version_is_rejected(self):
        with patch("tools.sign_ota_release.subprocess.run") as run:
            with self.assertRaisesRegex(ValueError, "major.minor.patch"):
                sign_ota_release.sign_release(
                    self.firmware,
                    "v1.2.3",
                    self.private_key,
                    self.output,
                    "v1.2.3",
                )
        run.assert_not_called()

    def test_private_key_inside_repository_is_rejected(self):
        repository_key = self.repository / "signing-key.pem"
        repository_key.write_text("test-only placeholder")
        with self.assertRaisesRegex(ValueError, "outside the repository"):
            sign_ota_release.sign_release(
                self.firmware,
                "1.2.3",
                repository_key,
                self.output,
                "v1.2.3",
            )

    def test_output_outside_release_artifacts_is_rejected(self):
        with self.assertRaisesRegex(ValueError, "directly inside"):
            sign_ota_release.sign_release(
                self.firmware,
                "1.2.3",
                self.private_key,
                self.root / "manifest.json",
                "v1.2.3",
            )

    def test_existing_output_is_never_overwritten(self):
        original = b"existing output"
        self.output.write_bytes(original)
        with self.assertRaisesRegex(ValueError, "refusing to overwrite"):
            sign_ota_release.sign_release(
                self.firmware,
                "1.2.3",
                self.private_key,
                self.output,
                "v1.2.3",
            )
        self.assertEqual(self.output.read_bytes(), original)

    def test_release_tag_must_match_manifest_version_exactly(self):
        with patch("tools.sign_ota_release.subprocess.run") as run:
            with self.assertRaisesRegex(ValueError, "exact v/V-prefixed"):
                sign_ota_release.sign_release(
                    self.firmware,
                    "1.2.3",
                    self.private_key,
                    self.output,
                    "V1.2.4",
                )
        run.assert_not_called()

    def test_rfc8032_ed25519_signature_accepts_valid_and_rejects_invalid(self):
        node = shutil.which("node")
        self.assertIsNotNone(node, "Node.js is required for Ed25519 verification tests.")
        public_key = (
            "d75a980182b10ab7d54bfed3c964073a"
            "0ee172f3daa62325af021a68f707511a"
        )
        signature = (
            "e5564300c360ac729086e2cc806e828a"
            "84877f1eb8e5d974d873e06522490155"
            "5fb8821590a33bacc61e39701cf9b46b"
            "d25bf5f0595bbe24655141438e7a100b"
        )
        script = """
const crypto = require('node:crypto');
const key = crypto.createPublicKey({
  key: Buffer.from('302a300506032b6570032100' + process.argv[1], 'hex'),
  format: 'der',
  type: 'spki'
});
const signature = Buffer.from(process.argv[2], 'hex');
const valid = crypto.verify(null, Buffer.alloc(0), key, signature);
signature[0] ^= 1;
const invalid = crypto.verify(null, Buffer.alloc(0), key, signature);
process.stdout.write(JSON.stringify({ valid, invalid }));
"""
        result = subprocess.run(
            [node, "-e", script, public_key, signature],
            check=True,
            capture_output=True,
            text=True,
        )
        self.assertEqual(json.loads(result.stdout), {"valid": True, "invalid": False})


if __name__ == "__main__":
    unittest.main()
