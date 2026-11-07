# Smart Notice Board test report

**Run date:** 2026-11-08  
**Firmware target:** PlatformIO `esp32dev`, ESP32 Arduino framework  
**Scope:** Code inspection and automated checks after the firmware and dashboard changes.

The hardware results below are the results supplied by the project owner. They
were not rerun after these changes because no ESP32, LCD, or project Wi-Fi
network is attached to this test environment. “Not tested” means no result was
provided and the behavior still needs physical verification.

| # | Test name | Expected result | Actual result | Status | Error details | Fix required |
|---:|---|---|---|---|---|---|
| 1 | ESP32 startup | Firmware starts, LCD initializes, AP and HTTP server start. | Owner reported startup passed before these changes. New firmware compiles; it was not flashed. | PASS (owner-reported baseline) | Post-change startup not observed on hardware. | Flash and verify serial startup messages. |
| 2 | Initial Wi-Fi connection | Entered credentials are saved and the board reports connection only after joining that SSID. | Owner reported initial Wi-Fi connection failed. | FAIL (owner-reported baseline) | The dashboard had a fixed device URL; the browser test also confirmed that an HTTPS-forwarded dashboard blocks HTTP ESP32 requests. No serial log establishes which caused the original failure. | Configure the device address in the dashboard and use an HTTP dashboard origin or an HTTPS proxy; retest with serial output. |
| 3 | Incorrect Wi-Fi password | Connection fails with a visible timeout/error and the HTTP server remains responsive. | No hardware result supplied. | NOT TESTED | The revised firmware reports a 30-second connection timeout. | Test with a deliberately incorrect password after flashing. |
| 4 | Empty SSID | Request is rejected; no empty credentials are saved or used. | No hardware result supplied. | NOT TESTED | Firmware and dashboard now reject an empty/whitespace-only SSID. | Send an empty SSID through the dashboard and confirm HTTP 400. |
| 5 | Wi-Fi connection timeout | A failed attempt leaves the server responsive and reports a timeout. | No hardware result supplied. | NOT TESTED | Timeout handling is implemented but has not been measured on the board. | Test with an unavailable network and poll `/status`. |
| 6 | Successful Wi-Fi connection | Status reports connected only after the requested SSID is connected and shows the station IP. | No post-change hardware result supplied. | NOT TESTED | The firmware now checks the target SSID and the dashboard waits for status confirmation. | Connect to a valid network and compare status with the LCD IP. |
| 7 | Dashboard status updates | Polling reflects connected, connecting, disconnected, and unreachable states. | No hardware result supplied. | NOT TESTED | API status validation and endpoint behavior have automated frontend coverage; physical polling was unavailable. | Verify the dashboard while connecting and after disconnecting. |
| 8 | Sending a short notice | Notice appears left-aligned on the LCD. | Owner reported pass before these changes. | PASS (owner-reported baseline) | New firmware has not been tested on the LCD. | Retest after flashing. |
| 9 | Sending exactly 16 characters | All 16 characters display in order with no scroll. | Owner reported pass before these changes. | PASS (owner-reported baseline) | New firmware has not been tested on the LCD. | Retest after flashing. |
| 10 | Sending a long notice | Message scrolls one character per step and repeats. | Owner reported long-notice scrolling passed before these changes. | PASS (owner-reported baseline) | The reported result does not confirm the starting character or restart boundary. | Verify the first and final frames after flashing. |
| 11 | 200-character notice limit | Input is capped at 200 characters and renders without overflow. | Owner reported not tested. | NOT TESTED | The firmware truncates notices to 200 characters. | Submit more than 200 characters and confirm the displayed/stored text is capped. |
| 12 | Empty notice rejection | Empty or whitespace-only notice returns an error and does not replace the current notice. | Owner reported pass before these changes. | PASS (owner-reported baseline) | New firmware has not been tested on the board. | Retest after flashing. |
| 13 | Scrolling starts at the first character | The initial frame begins with character 1 and is held for five seconds. | Earlier reported LCD behavior began in the middle despite the counter starting at zero; post-change hardware result is unavailable. | FAIL (previous observation; retest required) | The frame calculation starts at offset zero and the cursor is explicitly set for both DDRAM sections. The remaining discrepancy needs physical verification of the JHD161A's section addressing, wiring, and RW/ground connections. | Flash and verify a known 20+ character test notice from its first character; inspect wiring/addressing if it still appears shifted. |
| 14 | Scrolling restart | The trailing frame completes and the notice restarts at character 1. | No hardware result supplied. | NOT TESTED | Scroll wrap logic compiles but has not been observed on the display. | Watch at least one full cycle after flashing. |
| 15 | Wi-Fi disconnect | Station disconnects while saved credentials remain available. | Owner reported pass before these changes. | PASS (owner-reported baseline) | New firmware has not been tested on the board. | Retest and then use the saved-credential reconnect test. |
| 16 | Manual reconnect | Reconnect action starts a single attempt and status confirms its outcome. | Owner reported manual reconnect failed. | FAIL (owner-reported baseline) | The dashboard previously kept using a fixed station IP after disconnecting. That station route is no longer available; no failed HTTP log was supplied to prove this was the only cause. | The disconnect flow now switches the dashboard to the still-running setup AP address; connect the browser to the board AP before reconnecting. |
| 17 | Reconnection with saved credentials | `/reconnect` reads Preferences and joins the saved SSID without re-entering credentials. | No separate result supplied. | NOT TESTED | Manual reconnect failure does not establish whether the saved values were absent, stale, or rejected by the router. | Verify Preferences persistence and reconnect after disconnect. |
| 18 | ESP32 restart and Wi-Fi recovery | Saved credentials are loaded after reboot and station reconnection begins automatically. | Owner reported not tested. | NOT TESTED | Startup code invokes the saved-credential path; hardware reboot behavior is unverified. | Reboot and confirm station IP/status without using the connect form. |
| 19 | Router shutdown and recovery | The board detects loss and retries saved credentials when the router returns. | Owner reported automatic Wi-Fi recovery passed. | PASS (owner-reported baseline) | Post-change recovery timing has not been measured. | Retest after flashing; observe status through outage and recovery. |
| 20 | React communication after reconnection | The dashboard reaches the board at its current address and can poll status/send a notice. | No hardware result supplied. | NOT TESTED | The browser test found HTTPS-to-HTTP mixed-content blocking for the forwarded dashboard; no ESP32 was present for integration testing. | Use the correct device address and an HTTP dashboard origin or HTTPS proxy, then test status and notice endpoints. |

## Automated checks run

| Check | Result | Notes |
|---|---|---|
| PlatformIO firmware build | PASS | `platformio run`, ESP32 framework 3.3.12; no compiler warnings appeared in the build output. |
| PlatformIO dependencies | PASS | Resolved `LiquidCrystal 1.0.7`, `ArduinoJson 7.4.3`, `Preferences`, `WebServer`, and `WiFi`. |
| Dashboard production build | PASS | `npm run build`; Vite 8.3.6. |
| Dashboard lint | PASS | `npm run lint`; no errors or warnings. |
| Dashboard API tests | PASS | `npm test`; 6 tests cover address validation/storage, endpoint/payload mapping, response validation, HTTP/network errors, and HTTPS-to-HTTP blocking. |
| Firmware logic unit tests | NOT AVAILABLE | The project has no host-side firmware unit-test harness. Scroll boundaries and Wi-Fi transitions still need board-level verification. |
| Browser smoke check | PARTIAL | The React screen rendered after a full reload; empty-SSID, short-password, and invalid-address validation worked. Hot reload through the forwarded tunnel briefly returned 504s. The forwarded page used HTTPS and the browser blocked HTTP requests to the ESP32; no device integration was possible. |

## Findings and retest notes

- The dashboard previously sent every request to `10.178.221.82`, while UI
  fallbacks also contained `10.183.44.82`. Neither address was derived from the
  ESP32's current DHCP lease. The dashboard now has a configurable address
  saved in browser storage, with the firmware's setup AP address as the initial
  default.
- A dashboard served over HTTPS cannot directly call this firmware's HTTP
  server from a browser. Use the dashboard over HTTP on a network that can
  reach the ESP32, or place an HTTPS proxy in front of the device.
- The prior firmware could mistake an existing station connection for success
  during a new connection attempt and did not prevent concurrent attempts. The
  revised state logic cancels the previous station attempt, confirms the
  requested SSID, rejects duplicate requests, and exposes timeout details.
- A manual station disconnect can make the station IP unreachable even though
  the setup AP remains active. The firmware now sends its disconnect response
  before dropping the station, and the dashboard switches to the AP address
  for the subsequent reconnect action.
- The JHD161A's one visible row uses two 8-character DDRAM sections. The
  existing GPIO mapping is unchanged; the firmware writes the first half at
  row-0 address and the second half at row-1 address. The LCD now shows the
  actual station IP after connection.
- No claim of physical LCD, Wi-Fi, or ESP32 integration success is made for the
  revised firmware until the owner runs the hardware tests above.
