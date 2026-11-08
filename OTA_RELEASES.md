# Signed OTA release process

## Current safeguards and prerequisites

- `include/ota_config.h` contains the public-key placeholder. Until it is
  replaced with the owner's 32-byte Ed25519 public key (64 hex characters),
  the firmware rejects OTA requests before downloading a release.
- The private signing key must stay offline and outside this repository. Do
  not generate, commit, upload, or paste the private key into the dashboard,
  backend, firmware, or a GitHub Release.
- The fixed manifest and firmware URLs target public GitHub Release assets for
  `bhargavvenkatasai21-cpu/Smart-Notice-Board`.
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

1. Update `kFirmwareVersion` in `src/main.cpp` to the new numeric
   `major.minor.patch` version.
2. Build from the repository root:

   ```powershell
   C:\Users\bharg\.platformio\penv\Scripts\pio.exe run
   ```

3. Use the private key from its external offline path to create a manifest:

   ```powershell
   python tools\sign_ota_release.py `
     --firmware .pio\build\esp32dev\firmware.bin `
     --version 1.0.1 `
     --private-key C:\offline-signing\smart-notice-board-ota-private.pem `
     --output release-artifacts\manifest.json
   ```

   The signer rejects invalid versions, non-regular or oversized firmware,
   private-key paths inside the repository, and output paths outside
   `release-artifacts\`. It never overwrites an existing manifest. It creates
   no private key and writes the signed manifest under the ignored
   `release-artifacts\` directory.

4. Create a GitHub Release tagged `v1.0.1` and upload exactly these assets:
   `firmware.bin` and `manifest.json`. Mark it as the latest release. Do not
   upload the private key or other secrets.

The manifest has this schema:

```json
{
  "schemaVersion": 1,
  "version": "1.0.1",
  "firmwareUrl": "https://github.com/bhargavvenkatasai21-cpu/Smart-Notice-Board/releases/download/v1.0.1/firmware.bin",
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

5. After publishing, sign in to the dashboard, open **Wi-Fi configuration**,
   and choose **Check for signed update**. The device installs only a signed,
   newer release. The dashboard reports success only after the ESP32 reboots
   and reports the expected version.

## Failure behavior and limits

- A missing/invalid public key, bad signature, unsupported manifest, invalid
  URL, wrong size/hash, invalid image, TLS failure, and downgrade are rejected.
  HTTPS redirects are limited to five and cannot change to a non-HTTPS scheme;
  redirected hosts still use the configured CA trust roots.
- A version equal to the running version is reported as up-to-date.
- The backend operation is process-memory state and requires one backend
  instance. A process restart can interrupt dashboard polling.
- A newer image can be selected as the next OTA slot only after all checks
  pass. Power-loss recovery, failed-boot rollback, and real GitHub download
  behavior must still be verified on the physical board.
- No release was created, uploaded, deployed, or installed as part of this
  work.
