# Smart Notice Board test report

**Automated check date:** 2026-11-08  
**Firmware target:** PlatformIO `esp32dev`, ESP32 Arduino framework  
**Scope:** Frontend tests/build/lint, backend API/WebSocket/security tests,
firmware compilation, signed-OTA implementation, partition-table validation,
and Git/configuration checks.

The hardware results below are the results supplied by the project owner. They
were not rerun after these changes because no ESP32, LCD, or project Wi-Fi
network is attached to this test environment. “Not tested” means no result was
provided and the behavior still needs physical verification.

| # | Test name | Expected result | Actual result | Status | Error details | Fix required |
|---:|---|---|---|---|---|---|
| 1 | ESP32 startup | Firmware starts, LCD initializes, AP and HTTP server start. | Owner reported startup passed before these changes. New firmware compiles; it was not flashed. | PASS (owner-reported baseline) | Post-change startup not observed on hardware. | Flash and verify serial startup messages. |
| 2 | Initial Wi-Fi connection | Local setup submits credentials over the ESP32 access point; production dashboard avoids direct HTTP calls to the device. | Owner-reported initial Wi-Fi connection failed; current local setup was not hardware-tested. | FAIL (owner-reported baseline; retest required) | Deployed dashboard now sends status and notices through the HTTPS backend. | Test local Wi-Fi provisioning with the flashed firmware and inspect Serial Monitor output. |
| 3 | Incorrect Wi-Fi password | Connection fails with a visible timeout/error and the HTTP server remains responsive. | No hardware result supplied. | NOT TESTED | The revised firmware reports a 30-second connection timeout. | Test with a deliberately incorrect password after flashing. |
| 4 | Empty SSID | Request is rejected; no empty credentials are saved or used. | No hardware result supplied. | NOT TESTED | Firmware and dashboard now reject an empty/whitespace-only SSID. | Send an empty SSID through the dashboard and confirm HTTP 400. |
| 5 | Wi-Fi connection timeout | A failed attempt leaves the server responsive and reports a timeout. | No hardware result supplied. | NOT TESTED | Timeout handling is implemented but has not been measured on the board. | Test with an unavailable network and poll `/status`. |
| 6 | Successful Wi-Fi connection | Status reports connected only after the requested SSID is connected and shows the station IP. | No post-change hardware result supplied. | NOT TESTED | The firmware now checks the target SSID and the dashboard waits for status confirmation. | Connect to a valid network and compare status with the LCD IP. |
| 7 | Dashboard status updates | Dashboard separately shows backend, ESP32, WebSocket, and last communication status. | Frontend tests and backend simulated-device tests pass; no physical device was available. | PASS (automated) / NOT TESTED (hardware) | Backend status is not inferred from backend health alone. | Verify live transitions with the ESP32 connected and disconnected. |
| 8 | Sending a short notice | Notice appears left-aligned on the LCD. | Owner reported pass before these changes. | PASS (owner-reported baseline) | New firmware has not been tested on the LCD. | Retest after flashing. |
| 9 | Sending exactly 16 characters | All 16 characters display in order with no scroll. | Owner reported pass before these changes. | PASS (owner-reported baseline) | New firmware has not been tested on the LCD. | Retest after flashing. |
| 10 | Sending a long notice | Message scrolls one character per step and repeats. | Owner reported long-notice scrolling passed before these changes. | PASS (owner-reported baseline) | The reported result does not confirm the starting character or restart boundary. | Verify the first and final frames after flashing. |
| 11 | 200-character notice limit | Exactly 200 characters are accepted; longer notices are rejected. | Frontend and backend tests cover the 200-character maximum; physical request was not run. | PASS (automated validation) / NOT TESTED (hardware) | No physical ESP32 was available. | Verify the limit against the flashed board's local notice endpoint. |
| 12 | Empty notice rejection | Empty or whitespace-only notice returns an error and does not replace the current notice. | Owner reported pass before these changes. | PASS (owner-reported baseline) | New firmware has not been tested on the board. | Retest after flashing. |
| 13 | Scrolling starts at the first character | The initial frame begins with character 1 and is held for five seconds. | Earlier reported LCD behavior began in the middle despite the counter starting at zero; post-change hardware result is unavailable. | FAIL (previous observation; retest required) | The frame calculation starts at offset zero and the cursor is explicitly set for both DDRAM sections. The remaining discrepancy needs physical verification of the JHD161A's section addressing, wiring, and RW/ground connections. | Flash and verify a known 20+ character test notice from its first character; inspect wiring/addressing if it still appears shifted. |
| 14 | Scrolling restart | The trailing frame completes and the notice restarts at character 1. | No hardware result supplied. | NOT TESTED | Scroll wrap logic compiles but has not been observed on the display. | Watch at least one full cycle after flashing. |
| 15 | Wi-Fi disconnect | Station disconnects while saved credentials remain available. | Owner reported pass before these changes. | PASS (owner-reported baseline) | New firmware has not been tested on the board. | Retest and then use the saved-credential reconnect test. |
| 16 | Manual reconnect | Reconnect action starts a single attempt and status confirms its outcome. | Owner reported manual reconnect failed. | FAIL (owner-reported baseline) | The dashboard previously kept using a fixed station IP after disconnecting. That station route is no longer available; no failed HTTP log was supplied to prove this was the only cause. | The disconnect flow now switches the dashboard to the still-running setup AP address; connect the browser to the board AP before reconnecting. |
| 17 | Reconnection with saved credentials | `/reconnect` reads Preferences and joins the saved SSID without re-entering credentials. | No separate result supplied. | NOT TESTED | Manual reconnect failure does not establish whether the saved values were absent, stale, or rejected by the router. | Verify Preferences persistence and reconnect after disconnect. |
| 18 | ESP32 restart and Wi-Fi recovery | Saved credentials are loaded after reboot and station reconnection begins automatically. | Owner reported not tested. | NOT TESTED | Startup code invokes the saved-credential path; hardware reboot behavior is unverified. | Reboot and confirm station IP/status without using the connect form. |
| 19 | Router shutdown and recovery | The board detects loss and retries saved credentials when the router returns. | Owner reported automatic Wi-Fi recovery passed. | PASS (owner-reported baseline) | Post-change recovery timing has not been measured. | Retest after flashing; observe status through outage and recovery. |
| 20 | Dashboard-to-device notice delivery | Dashboard sends notice through authenticated HTTPS API; success waits for an ESP32 WebSocket acknowledgment. | Backend integration test passes with a simulated authenticated device. No physical LCD test was run. | PASS (simulated backend) / NOT TESTED (hardware) | Firmware acknowledges after running the LCD display routine; physical LCD output cannot be sensed remotely. | Flash firmware and confirm notice/acknowledgment behavior on the board and LCD. |
| 21 | Remote Wi-Fi configuration | Authenticated dashboard credentials reach the ESP32; result is confirmed only after backend reconnection, with prior credentials retained on failure. | Dashboard service/UI tests and backend simulated-device tests pass; firmware compiles. No physical Wi-Fi test was run. | PASS (automated) / NOT TESTED (hardware) | Backend operation state is in memory and requires a single backend instance. ESP32 Preferences/NVS credentials are not application-encrypted. | Flash firmware; test success, wrong password, backend loss, rollback, and recovery AP behavior on the board. |
| 22 | Forget saved Wi-Fi | Explicit confirmation clears NVS credentials, reports the result, and keeps the recovery AP available. | Dashboard, backend operation-state tests, and firmware compilation pass. No board test was run. | PASS (automated) / NOT TESTED (hardware) | Backend tests simulate accepted, deleted, failed, and timed-out responses. | Verify actual NVS deletion, station disconnect, and recovery AP access. |
| 23 | Signed OTA | Device installs only a signed, newer image over verified HTTPS and confirms its version after reboot. | Firmware compiles; signer-size, canonical-payload, and valid/invalid Ed25519-vector tests pass. No release or hardware OTA test is available. | PASS (implementation/build) / NOT TESTED (runtime) | OTA remains disabled because the owner-provided public key is empty. | Configure the owner public key, publish a signed test release, then complete the physical OTA checklist. |
| 24 | TLS trust anchors | WSS and OTA HTTPS use trusted CA validation and reject invalid certificates. | Certificate-verified live TLS handshakes succeeded for the Render host, GitHub, and the release-assets host using the embedded roots. Installed WebSockets 2.7.3 calls `setCACert`; HTTPClient redirects remain HTTPS and use the CA-configured client. | PASS (live host TLS/source/build) / NOT TESTED (hardware) | CA roots are trust anchors, not certificate pins; a physical ESP32 handshake was not run. | Verify backend WSS and GitHub release downloads on the physical device. |

## Automated checks run

| Check | Result | Notes |
|---|---|---|
| PlatformIO firmware build | PASS | `C:\Users\bharg\.platformio\penv\Scripts\pio.exe run`; ESP32 framework 3.3.12. Firmware was compiled, not flashed. ELF flash usage is 1,322,713 / 1,507,328 bytes (87.8%); the generated binary is 1,354,512 bytes, leaving 152,816 bytes (10.1%) in the OTA slot. |
| PlatformIO dependencies | PASS | Resolved `LiquidCrystal 1.0.7`, `ArduinoJson 7.4.3`, `WebSockets 2.7.3`, `Preferences`, `WebServer`, and `WiFi`. |
| Dashboard production build | PASS | `npm run build`; Vite 8.3.6. |
| Dashboard lint | PASS | `npm run lint`; no errors or warnings. |
| Dashboard tests | PASS | `npm test`; 67 tests passed across 5 files, including Wi-Fi forget and OTA service/UI behavior. |
| Backend integration tests | PASS | `npm test`; 18 tests passed, including login throttling, credential deletion states, firmware operation transitions, post-reboot version verification, notice acknowledgment, and Wi-Fi configuration. Uses a simulated WebSocket device. |
| OTA signer and AP-password tests | PASS | `python -m unittest discover -s tests -v`; 14 tests passed, including oversize rejection, exact-size acceptance, canonical-message parity, safe output/key paths, a public RFC Ed25519 valid/invalid vector, and production-upload gate behavior. No signing key was generated or used. |
| TLS certificate validation | PASS | A Python SSL context containing only `include/trust_roots.h` roots verified live TLS handshakes to `smart-notice-board-api.onrender.com`, `github.com`, and `release-assets.githubusercontent.com`. |
| PlatformIO production-upload gate | PASS (policy) | The extra script blocks upload targets unless ignored `include/secrets.h` has one custom, non-default 8–63 byte `BOARD_AP_PASSWORD`. Policy tests passed; no upload command was run. |
| Backend env variable names | PASS | Local ignored `.env` and `.env.example` variable names match. Values were not printed. |
| Partition layout | PASS | The custom table was decoded with Espressif's generator; all partition boundaries fit the 4 MiB flash. |
| Git secret/artifact audit | PASS | No real `.env`, `secrets.h`, signing private key, release artifact, or firmware build output is tracked. Local `.env` and `include/secrets.h` remain ignored. |
| `git diff --check` | PASS | No whitespace errors. |
| Render health and local credential smoke check | NOT RERUN | This change made no Render request or setting change. Historical results are not treated as current deployment verification. |
| Firmware logic unit tests | NOT AVAILABLE | The project has no host-side firmware unit-test harness. Wi-Fi transitions and cryptographic OTA behavior need hardware/release-level verification. |
| Browser/device integration check | NOT TESTED | No physical ESP32, LCD, or project Wi-Fi network was accessible. Backend integration used a simulated WebSocket device. |
| Dependency audit | 6 MODERATE ADVISORIES | Fresh `npm audit`: backend 2 moderate, dashboard 4 moderate; no high/critical advisories. npm proposes `--force` dependency changes that downgrade/replace major versions, so dependencies and lockfiles were left unchanged. |

## Findings and retest notes

- The local setup page retains ESP32 discovery without scanning arbitrary
  private-network addresses. It probes the setup AP (`192.168.4.1`), a
  manually configured override, and the last station IP reported by the ESP32.
  A successful `/status` response refreshes the station IP in session storage.
- Provisioning requires the user to connect their phone/computer to
  `SmartNoticeBoard` (configured `BOARD_AP_PASSWORD`, or the legacy fallback
  `12345678` in a development build with a serial warning), open the dashboard
  over HTTP, submit router credentials, then manually return to the router
  Wi-Fi after the board reports its DHCP IP. PlatformIO refuses firmware
  uploads without a custom, non-default password. A browser cannot switch its
  own network connection.
- If the router uses guest-network isolation, client-isolation settings, or
  otherwise blocks device-to-device traffic, the dashboard cannot reach the
  station IP. Keep the setup AP reachable for provisioning or use a VPN/secure
  relay; HTTPS hosting also requires an HTTPS reverse proxy or secure relay
  because browsers block direct HTTPS-page-to-HTTP-device requests.
- Production status and notice requests now use the HTTPS backend; direct
  ESP32 HTTP discovery and Wi-Fi setup are restricted to the local HTTP
  development dashboard to avoid mixed-content requests.
- The backend allows configured dashboard origins from `DASHBOARD_ORIGIN`.
  Render must be configured with the exact deployed Static Site origin.
- The dashboard access code is checked only by the backend and exchanged for
  an opaque session token; the code is not embedded in `VITE_*` variables.
  Sessions expire after 12 hours, or 30 days when Remember me is selected.
  Remember me stores the session token, not the code, in localStorage; scripts
  on the same origin can still read it, so shared-device and XSS risks remain.
  Sessions are held in memory and are invalidated on backend restart. The
  configured shared code is short and guessable, so this is not appropriate
  for sensitive or broad public access; use individual authentication and
  stronger credentials for production use. The in-memory sessions are not
  shared across backend instances.
- The backend sends a notice over the authenticated WebSocket and waits for a
  matching `NOTICE_ACK`. It returns success only after firmware acknowledges
  the display routine. The acknowledgment does not prove that the LCD hardware
  physically rendered the characters.
- Remote Wi-Fi configuration is available only while the ESP32 is connected
  and authenticated. It travels through the authenticated HTTPS backend and
  existing authenticated WSS channel. The API omits passwords from operation
  status responses. The backend holds operations in memory, so use one backend
  instance; a restart or process split can prevent the dashboard from
  confirming an in-progress operation.
- Firmware commits replacement credentials only after Wi-Fi and backend
  authentication succeed. On a connection or persistence failure it attempts
  to restore the previously saved network while leaving the setup AP enabled.
  Credentials remain plaintext in ESP32 Preferences/NVS, and there is no
  physical-board verification in this report.
- The prior firmware could mistake an existing station connection for success
  during a new connection attempt and did not prevent concurrent attempts. The
  revised state logic cancels the previous station attempt, confirms the
  requested SSID, rejects duplicate requests, and exposes timeout details.
- A manual station disconnect can make the station IP unreachable even though
  the setup AP remains active. The firmware now sends its disconnect response
  before dropping the station, and the dashboard switches to the AP address
  for the subsequent reconnect action.
- The JHD161A's one visible row uses two 8-character DDRAM sections. The
  existing GPIO mapping is unchanged; the firmware retains the split-write
  behavior. The firmware now enforces the 200-character notice maximum and
  keeps the second display row blank. These LCD behaviors have not been
  confirmed on the physical display after the changes.
- No claim of physical LCD, Wi-Fi, or ESP32 integration success is made for the
  revised firmware until the owner runs the hardware tests above.
- OTA is compiled but disabled until the owner configures the public key in
  `include/ota_config.h`; the matching private key must remain offline and
  outside the repository. No OTA release was created or installed.

## Run and upload commands

Start the dashboard over HTTP so the browser can communicate with the ESP32:

```powershell
Set-Location D:\iot\Smart-Notice-Board\smart-notice-dashboard
npm run dev -- --host 0.0.0.0
```

Open `http://localhost:5173` in a browser on the same computer. For first-time
provisioning, connect that computer or phone to `SmartNoticeBoard`, submit the
router credentials, wait for the reported station IP, then manually reconnect
the computer or phone to the router Wi-Fi.

Build, upload, and open the serial monitor from the project root:

```powershell
Set-Location D:\iot\Smart-Notice-Board
C:\Users\bharg\.platformio\penv\Scripts\pio.exe run
C:\Users\bharg\.platformio\penv\Scripts\pio.exe run --target upload
C:\Users\bharg\.platformio\penv\Scripts\pio.exe device monitor --baud 115200
```

If PlatformIO cannot identify the serial port, specify it with `--environment
esp32dev --upload-port COMx` and `--port COMx` for the monitor, replacing
`COMx` with the ESP32's port in Device Manager.
