# Signed OTA release process

## Current safeguards and prerequisites

- `include/ota_config.h` contains the Ed25519 public trust key. OTA rejects
  requests if the configured key is absent or invalid; only the matching
  private signing key can create accepted releases.
- The private signing key must stay offline and outside this repository. Do
  not generate, commit, upload, or paste the private key into the dashboard,
  backend, firmware, or a GitHub Release.
- The device queries GitHub's `/releases/latest` API, which omits draft and
  prerelease releases. It selects the version-specific manifest asset
  (`manifest-<version>.json`) or the legacy `manifest.json` asset, then uses
  the exact firmware URL signed into that manifest. The existing releases
  confirmed this asset layout: V1.0.3 and V1.0.2 use versioned manifests;
  v1.0.1 uses `manifest.json`.
- OTA requires the custom partition table and a firmware image no larger than
  the 1,507,328-byte OTA slot. The signer and device both reject larger images.

## Prepare a signing key offline

If the owner does not already have a key, create it on an offline trusted
machine and store it outside the repository. This command is documentation
only; no key was generated for this project:

```powershell
openssl genpkey -algorithm ED25519 -out C:\offline-signing\smart-notice-board-ota-private.pem
```

Export the public key in DER form and print the final 32 bytes as hex:

```powershell
openssl pkey -in C:\offline-signing\smart-notice-board-ota-private.pem -pubout -outform DER -out C:\offline-signing\smart-notice-board-ota-public.der
python -c "from pathlib import Path; print(Path(r'C:\offline-signing\smart-notice-board-ota-public.der').read_bytes()[-32:].hex())"
```

Copy only that public hex value into `BOARD_OTA_ED25519_PUBLIC_KEY_HEX` in
`include/ota_config.h`, rebuild, and install the firmware through the approved
USB process. Verify the public key carefully; changing it later requires a
trusted firmware update.

## Build and sign one release

1. Select the new numeric `major.minor.patch` version as build metadata; no
   firmware source edit is required. Build from the repository root:

   ```powershell
   $env:BOARD_FIRMWARE_VERSION = "1.0.4"
   C:\Users\bharg\.platformio\penv\Scripts\pio.exe run
   ```

2. Use the exact release tag (`V1.0.4` or `v1.0.4`) and the private key from
   its external offline path to create a versioned manifest:

   ```powershell
   python tools\sign_ota_release.py `
     --firmware .pio\build\esp32dev\firmware.bin `
     --version 1.0.4 `
     --tag V1.0.4 `
     --private-key C:\offline-signing\smart-notice-board-ota-private.pem `
     --output release-artifacts\manifest-1.0.4.json
   ```

   The signer requires the tag explicitly so the signed asset URL exactly
   matches the release tag. It rejects invalid versions/tags, non-regular or
   oversized firmware, private-key paths inside the repository, and output
   paths outside `release-artifacts\`. It never overwrites an existing
   manifest and writes it under the ignored `release-artifacts\` directory.

3. Create a stable, non-draft GitHub Release with the same exact tag supplied
   to the signer. Upload `firmware.bin` and `manifest-1.0.4.json` as release
   assets. GitHub latest-release discovery ignores drafts and prereleases; do
   not mark a test release as latest. Never upload the private key or other
   secrets.

The manifest has this schema:

```json
{
  "schemaVersion": 1,
  "version": "1.0.1",
  "firmwareUrl": "https://github.com/bhargavvenkatasai21-cpu/Smart-Notice-Board/releases/download/V1.0.4/firmware.bin",
  "size": 1330000,
  "sha256": "64 lowercase hex characters",
  "signature": "128 hex characters"
}
```

The signature is Ed25519 over this exact UTF-8 byte sequence, with LF newline
characters and no trailing newline:

```text
SmartNoticeBoard-OTA-v1
<version>
<size in decimal bytes>
<lowercase SHA-256 hex>
<exact firmwareUrl>
```

4. In the dashboard's **Wi-Fi configuration** page, choose **Check for signed
   update**. This only discovers and verifies release metadata; it never
   downloads or installs firmware. If a newer release is available, choose
   **Install v…**. If the device is already on that version, the separate
   **Reinstall current firmware** action requires an additional confirmation.
   The dashboard reports installation success only after the ESP32 reboots,
   reconnects, and reports the expected version.

## Failure behavior and limits

- A missing/invalid public key, bad signature, unsupported manifest, invalid
  tag or URL, wrong size/hash, invalid image, TLS failure, and downgrade are
  rejected. HTTPS redirects are limited to five; TLS certificate validation
  remains enabled for every redirect.
- Semver components are compared numerically. A newer release may be
  installed; an equal version is not downloaded unless reinstall is
  explicitly confirmed; an older version is always rejected.
- Serial diagnostics include selected release/tag and manifest URL, HTTP
  status and redirect destination, `Content-Length`, signed size, received
  bytes, OTA capacity, and expected versus actual SHA-256. A size or digest
  mismatch aborts `Update` and never activates the image.
- The backend operation is process-memory state and requires one backend
  instance. A process restart can interrupt dashboard polling.
- A newer image can be selected as the next OTA slot only after all checks
  pass. Power-loss recovery, failed-boot rollback, and real GitHub download
  behavior must still be verified on the physical board.
- No release was created, uploaded, deployed, or installed as part of this
  work.
