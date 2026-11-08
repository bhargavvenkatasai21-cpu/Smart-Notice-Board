# Security notes

## Credentials and access

- Keep `ESP32_DEVICE_TOKEN` and `DASHBOARD_ACCESS_CODE` in backend environment
  settings. Do not put either in a `VITE_*` setting or a committed file.
- The backend uses bearer sessions, limits sign-in to 10 failed attempts per
  client address per 15 minutes, and returns security headers. Sessions,
  device coordination, rate-limit counters, and operation results are held in
  process memory.
- Run one backend instance. Multiple instances do not share sessions, device
  sockets, or operation state.
- The ESP32 setup AP remains available for recovery. Firmware upload through
  PlatformIO is blocked unless the ignored `include/secrets.h` defines a
  custom, non-default 8–63 byte `BOARD_AP_PASSWORD`. Development builds
  without that setting retain the legacy password `12345678` and print a
  warning; do not flash such a build.
- Router credentials are stored in ESP32 Preferences/NVS without
  application-level encryption. Protect the device physically and use a
  trusted network.
- The local ESP32 HTTP provisioning API is intended for use from the setup AP.
  It is not a substitute for an authenticated internet-facing API.

## Transport security

The ESP32 validates TLS certificates for the backend WSS connection and OTA
downloads using the CA roots in `include/trust_roots.h`. It does not use
`setInsecure()`. These are CA trust anchors, not certificate or public-key
pins. Their expiration dates must be monitored and the bundle refreshed before
expiration:

- GlobalSign Root CA: 2028-01-28
- ISRG Root X1: 2035-06-04
- USERTrust ECC Certification Authority: 2038-01-18

The configured PEM bundle was tested against the live Render WebSocket host,
GitHub, and GitHub release-assets host. Certificate-verified TLS handshakes
succeeded for all three at audit time. This does not replace periodic
certificate-chain monitoring or an on-device connectivity test.

The ESP32 waits for network time (NTP) before starting TLS so certificate
validity dates can be checked. If NTP is unavailable, the AP/local HTTP setup
remains available but backend WSS and OTA remain unavailable; certificate
verification is never bypassed. Replacing a root requires rebuilding and
flashing the firmware. Physical TLS
connectivity has not yet been verified on the device.
## Firmware updates

OTA installs only a numerically newer `major.minor.patch` release. The device
checks the Ed25519 signature over a canonical payload containing version,
size, SHA-256 digest, and the exact GitHub release asset URL; it also checks
the downloaded image digest and lets the ESP32 updater validate the image.
Downloads are HTTPS-only and constrained to this repository's release asset
path.

OTA remains disabled until `BOARD_OTA_ED25519_PUBLIC_KEY_HEX` is configured in
`include/ota_config.h`. Keep the corresponding private key offline and outside
the repository. No key was generated or added by this change.

Version enforcement is application-level only. This project does not enable
ESP32 Secure Boot, eFuse anti-rollback, encrypted NVS, or a hardware-rooted
trust claim. A successful backend update state confirms that the device
reconnected and reported the expected version; it is not a substitute for
testing rollback and recovery behavior on hardware.

## Response to a suspected compromise

Rotate the dashboard access code and device token in the backend environment
and reflash the device with the matching token. Rebuild firmware with a new
OTA public key if the signing key is compromised; distribute that key change
through a trusted physical firmware update. Do not publish private keys,
tokens, access codes, or real Wi-Fi credentials in issues or release assets.
