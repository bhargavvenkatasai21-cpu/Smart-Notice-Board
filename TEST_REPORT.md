# Smart Notice Board Test Report

**Hardware test date:** 2026-11-08  
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
| 11 | Automatic reconnect after network interruption | ESP32 reconnected to Wi-Fi, re-established the Render WebSocket, and authenticated. | PASS |
| 12 | Remote Wi-Fi configuration | New Wi-Fi credentials were submitted from the dashboard; ESP32 connected to the new network. | PASS |
| 13 | Notice after remote Wi-Fi change | A new dashboard notice appeared correctly on the physical LCD after the network change. | PASS |
| 14 | Forget saved Wi-Fi | Dashboard reported: `Saved Wi-Fi credentials were deleted. The setup access point remains available.` | PASS (owner-reported) |
| 15 | Recovery AP after Forget Wi-Fi | `SmartNoticeBoard` setup AP remained available at `192.168.4.1`. | PASS |
| 16 | Local Wi-Fi re-provisioning | The local setup page accepted Wi-Fi credentials and ESP32 connected, receiving `192.168.179.82`. | PASS |
| 17 | Backend reconnect after local provisioning | ESP32 connected to Render and authenticated successfully after provisioning. | PASS |
| 18 | Network change through local setup | ESP32 changed networks, received `10.178.221.82`, and reconnected to Render and authenticated. | PASS |
| 19 | Notice after local network change | Serial Monitor showed a new notice received and LCD display processing started. | PASS (owner-reported) |
| 20 | Power-cycle recovery | After power was switched off and on, ESP32 automatically reconnected without manually entering Wi-Fi credentials. | PASS (owner-reported) |
| 21 | Signed OTA update | OTA remains disabled because the Ed25519 public key has not been configured. No OTA release or installation was performed. | NOT TESTED / DISABLED |

## 2. Automated checks

The following automated results were recorded in the earlier software audit. They are retained as reported results and were not independently rerun for this update.

| Check | Recorded result | Notes |
|---|---|---|
| PlatformIO firmware build | PASS | Firmware compiled successfully in the earlier audit. |
| Dashboard production build | PASS | Earlier audit reported `npm run build` passed. |
| Dashboard lint | PASS | Earlier audit reported no lint errors or warnings. |
| Dashboard tests | PASS | Earlier audit reported 67 tests passed across 5 files. |
| Backend integration tests | PASS | Earlier audit reported 18 tests passed, using a simulated WebSocket device. |
| OTA signer and AP-password tests | PASS | Earlier audit reported 14 Python tests passed. |
| TLS certificate validation | PASS | Earlier audit reported successful verified TLS handshakes to Render, GitHub, and GitHub release-assets hosts. |
| Partition layout validation | PASS | Earlier audit reported that the custom partition table fits 4 MiB flash. |
| Git secret/artifact audit | PASS | Earlier audit reported no real `.env`, `secrets.h`, signing private key, release artifact, or firmware build output tracked. |
| Dependency audit | 6 MODERATE ADVISORIES | Earlier audit reported 2 backend and 4 dashboard moderate advisories; no high/critical advisories. |

## 3. OTA status and limitations

- OTA functionality is implemented in the firmware but remains disabled until the owner configures the Ed25519 public key in `include/ota_config.h`.
- The matching private signing key must remain offline and outside the repository.
- No signed release has been created, published, downloaded, or installed.
- Physical OTA installation, reboot verification, rollback, and failure-recovery tests remain outstanding.
- OTA is not required for normal dashboard notice delivery or Wi-Fi configuration. USB firmware upload can continue to be used.

## 4. Security and operational notes

- Keep `include/secrets.h`, `.env` files, and any OTA private signing key out of Git.
- Use a unique, non-default `BOARD_AP_PASSWORD` for the ESP32 setup access point.
- Wi-Fi credentials are stored in ESP32 Preferences/NVS and are not application-encrypted.
- Dashboard sessions and backend operation state are held in memory; backend restarts can invalidate sessions or interrupt an in-progress Wi-Fi operation.
- The dashboard-to-device notice acknowledgment confirms the firmware's display routine was invoked; the physical LCD result must still be visually checked.
- Keep the setup access point available as a recovery path when changing Wi-Fi networks.

## 5. Remaining work

1. Update the separate `HARDWARE_TEST_CHECKLIST.md` to match these owner-reported physical results.
2. Test incorrect Wi-Fi passwords, unavailable networks, timeout handling, and rollback to previously saved credentials.
3. Verify LCD behavior for exact 16-character messages, 200-character messages, over-limit rejection, and a complete scrolling cycle.
4. Configure the Ed25519 public key and perform OTA tests only when ready to manage signing keys and publish a test release.
5. Review the six moderate npm advisories and plan safe dependency updates separately.

## 6. Overall result

The owner has successfully tested the main Smart Notice Board workflows on the physical ESP32: Wi-Fi provisioning through the local setup page and dashboard, network switching, Forget Wi-Fi, recovery access point availability, Render WebSocket reconnection, device authentication, notice delivery to the LCD, and automatic reconnection after a power cycle.

**Main project functionality: WORKING (owner-reported physical tests).**  
**Signed OTA: DISABLED / NOT TESTED.**  
**Additional negative-path and edge-case tests: STILL REQUIRED.**
