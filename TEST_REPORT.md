# Smart Notice Board Test Report

**Hardware test date:** 2026-11-08 (owner-reported historical results)
**Software validation date:** 2026-11-11
**Firmware target:** PlatformIO `esp32dev`, ESP32 Arduino framework  
**Scope:** Dashboard, backend, ESP32 firmware, Wi-Fi provisioning and recovery, LCD notice display, security, and signed OTA implementation.

## 1. Hardware test results

The following physical-device results are based on the project owner's tests and Serial Monitor output.

| # | Test | Actual result | Status |
|---:|---|---|---|
| 1 | ESP32 startup | ESP32 booted successfully. Setup access point and HTTP server started. | PASS |
| 2 | Local setup access point | `SmartNoticeBoard` AP started and was accessible at `192.168.4.1`. | PASS |
| 3 | Local setup page | Browser opened the local setup page. After the page was updated, it displayed Wi-Fi SSID/password fields and a Connect button. | PASS |
| 4 | Initial Wi-Fi provisioning | Credentials submitted through the local setup page. ESP32 received a DHCP IP and reported Wi-Fi connected. | PASS |
| 5 | Secure time synchronization | ESP32 requested network time before starting the secure backend connection. | PASS |
| 6 | Render WebSocket connection | Serial Monitor showed `Connected to Render WebSocket`. | PASS |
| 7 | ESP32 authentication | Serial Monitor showed `ESP32 authenticated successfully`. | PASS |
| 8 | Dashboard status | Dashboard reported Backend Online, ESP32 Online, and WebSocket Online. | PASS (owner-reported) |
| 9 | Short notice delivery | A notice sent from the dashboard was received by the ESP32 and displayed on the LCD. | PASS |
| 10 | LCD scrolling/display | LCD displayed the received notice. Serial Monitor showed `LCD notice display started at character 1`. | PASS (owner-reported) |
| 11 | Network recovery | Network changes/reconnections were observed; an isolated router-off automatic recovery test and timing were not recorded. | PARTIAL |
| 12 | Remote Wi-Fi configuration | New Wi-Fi credentials were submitted from the dashboard; ESP32 connected to the new network. | PASS |
| 13 | Notice after remote Wi-Fi change | A new dashboard notice appeared correctly on the physical LCD after the network change. | PASS |
| 14 | Forget saved Wi-Fi | Dashboard reported: `Saved Wi-Fi credentials were deleted. The setup access point remains available.` | PASS (owner-reported) |
| 15 | Recovery AP after Forget Wi-Fi | `SmartNoticeBoard` setup AP remained available at `192.168.4.1`. | PASS |
| 16 | Local Wi-Fi re-provisioning | The local setup page accepted Wi-Fi credentials and ESP32 connected, receiving `192.168.179.82`. | PASS |
| 17 | Backend reconnect after local provisioning | ESP32 connected to Render and authenticated successfully after provisioning. | PASS |
| 18 | Network change through local setup | ESP32 changed networks, received `10.178.221.82`, and reconnected to Render and authenticated. | PASS |
| 19 | Notice after local network change | Serial Monitor showed a new notice received and LCD display processing started. | PASS (owner-reported) |
| 20 | Power-cycle recovery | After power was switched off and on, ESP32 automatically reconnected without manually entering Wi-Fi credentials. | PASS (owner-reported) |
| 21 | Signed OTA update | No physical release check, download, installation, or reboot test was performed. | NOT TESTED |

## 2. Automated checks

The following software checks were run for the current changes on 2026-11-10.

| Check | Recorded result | Notes |
|---|---|---|
| Backend integration tests | PASS — 22 tests | Includes session persistence/expiry, cookie lifecycle and logout, authenticated device operations, WebSocket notice acknowledgment, and separate OTA check/install operations. |
| Dashboard tests | PASS — 68 tests across 5 files | Includes cookie-session restoration, auth initialization, explicit OTA check/install/reinstall controls, and service requests with credentials. |
| Dashboard lint | PASS | `npm run lint` |
| Dashboard production build | PASS | `npm run build` |
| OTA signer and helper tests | PASS — 15 tests | |
| PlatformIO firmware build | PASS | Compiled `esp32dev` with `BOARD_FIRMWARE_VERSION=1.0.3`, `1.0.10`, and `1.0.4`; the latest build used 85.3% of the configured application partition and 15.7% of RAM. No board was flashed. |
| Firmware version metadata validation | PASS | Numeric versions compiled without firmware source edits; an invalid prerelease version was rejected. |
| Firmware OTA/network runtime | NOT RUN | Requires device/release/network integration; compilation does not validate physical behavior. |
| Published stable release integrity | PASS | Queried GitHub latest: `V1.0.3` is stable, assets are `firmware.bin` and `manifest-1.0.3.json`; downloaded image size (1,297,616 bytes), SHA-256, and Ed25519 signature all match the manifest. |
| TLS certificate validation | Not rerun on device | Public release HTTPS transfer succeeded from this host; this does not establish ESP32 TLS behavior. |
| Dependency audit | Not rerun | Earlier audit reported six moderate advisories; no dependency changes were made. |

## 3. OTA status and limitations

- The prior firmware was pinned to one release manifest, and release tags use
  mixed `v`/`V` casing. Discovery now uses the GitHub latest-stable API and
  selects an asset from its actual release metadata; the signer requires the
  exact release tag. The historical device size/hash failure cannot be
  attributed conclusively without the device's serial log and exact uploaded
  image/manifest pair. The current published `V1.0.3` image and manifest have
  been independently checked and are internally consistent.
- OTA is enabled in the source with a configured Ed25519 public trust key in `include/ota_config.h`.
- The matching private signing key must remain offline and outside the repository.
- No signed release has been created, published, downloaded, or installed.
- The computer exposes a CP210x USB serial port at COM3, but its connection to
  the target ESP32 has not been confirmed. No firmware was flashed.
- Physical OTA release discovery, download, installation, reboot verification, rollback, and failure-recovery tests remain outstanding.
- OTA is not required for normal dashboard notice delivery or Wi-Fi configuration. USB firmware upload can continue to be used.

## 4. Security and operational notes

- Keep `include/secrets.h`, `.env` files, and any OTA private signing key out of Git.
- Use a unique, non-default `BOARD_AP_PASSWORD` for the ESP32 setup access point.
- Wi-Fi credentials are stored in ESP32 Preferences/NVS and are not application-encrypted.
- Dashboard sessions are stored as hashed session-token records in a configured persistent file; production deployment requires a Render persistent disk at the configured path. Device connections and operation state remain process-local, so run one backend instance.
- The dashboard-to-device notice acknowledgment confirms the firmware's display routine was invoked; the physical LCD result must still be visually checked.
- Keep the setup access point available as a recovery path when changing Wi-Fi networks.

## 5. Remaining work

1. Complete the physical steps in `HARDWARE_TEST_CHECKLIST.md`, including router outage/recovery and OTA check/install/reinstall/downgrade cases.
2. Test incorrect Wi-Fi passwords, unavailable networks, timeout handling, and rollback to previously saved credentials.
3. Verify LCD behavior for exact 16-character messages, 200-character messages, over-limit rejection, and a complete scrolling cycle.
4. Configure the Render persistent disk and deploy the backend/dashboard changes before testing browser sessions in production.
5. Review the six previously reported moderate npm advisories separately.

## 6. Overall result

The owner has successfully tested the main Smart Notice Board workflows on the physical ESP32: Wi-Fi provisioning through the local setup page and dashboard, network switching, Forget Wi-Fi, recovery access point availability, Render WebSocket reconnection, device authentication, notice delivery to the LCD, and automatic reconnection after a power cycle.

**Main project functionality: WORKING (owner-reported physical tests).**  
**Signed OTA: IMPLEMENTED; PHYSICAL TESTS NOT RUN.**
**Additional negative-path and edge-case tests: STILL REQUIRED.**
