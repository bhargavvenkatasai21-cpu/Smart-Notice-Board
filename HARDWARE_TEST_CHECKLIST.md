# Physical Hardware Validation Checklist

**Project:** Smart Notice Board  
**Validation date:** 2026-11-08  
**Firmware version observed:** 1.0.0  
**Board model / flash size:** Not recorded  
**Validation evidence:** Owner-reported physical tests and supplied Serial Monitor output

**Status key:** `[x]` verified; `[~]` partially verified; `[ ]` not yet verified. A compile or automated test is not treated as physical hardware evidence.

## Before flashing

- [ ] Confirm the ESP32 model has 4 MiB flash and the custom partition layout.
- [ ] Set a unique, non-default `BOARD_AP_PASSWORD` (8–63 bytes) in the ignored `include/secrets.h`; verify PlatformIO blocks upload without it.
- [ ] Confirm the device token matches the backend environment.
- [ ] If testing OTA, configure the owner's public key and verify the matching private key remains offline and outside the repository. **OTA is currently disabled; no OTA test was performed.**
- [ ] Keep USB serial recovery available. Do not erase NVS unless prepared to re-enter router credentials.

## Wi-Fi and recovery

- [x] Power up; verify AP and HTTP server startup in Serial Monitor. Observed `Access point started`, AP name `SmartNoticeBoard`, AP IP `192.168.4.1`, and HTTP server startup.
- [ ] Confirm the setup AP password is not the legacy default. Password configuration was not independently verified during the physical test.
- [x] Provision valid Wi-Fi credentials; verify the ESP32 obtains an IP and connects. Successful station IPs observed included `192.168.179.82` and `10.178.221.82`. Backend authentication subsequently succeeded.
- [ ] Try an incorrect password and unavailable SSID; verify timeout, no failed candidate credential is saved, and setup AP remains responsive.
- [x] Reboot / power-cycle and confirm saved credentials reconnect. Owner confirmed successful reconnection after powering the ESP32 off for approximately 10 seconds and turning it back on.
- [~] Confirm NTP obtains valid time before WSS starts; test with NTP blocked and verify TLS remains closed while the setup AP stays available. Serial output showed `Requesting network time for TLS validation`, followed by successful verified WSS connection and authentication, but an explicit time-sync success log and blocked-NTP test were not recorded.
- [~] Disconnect Wi-Fi, manually reconnect, stop and restore the router, and record recovery timing and RSSI. Network changes and reconnection were observed; router outage/recovery timing was not recorded. Dashboard reported RSSI `-67 dBm` during one status check.
- [x] Remotely configure a new network; verify successful backend authentication after the network change. Owner confirmed the new Wi-Fi connected; Serial Monitor showed a new IP, WSS connection, and successful device authentication.
- [ ] Test remote configuration failure and verify the previous saved network remains available.
- [x] Explicitly confirm **Forget saved Wi-Fi**; verify credentials are deleted and the setup AP remains available afterward. Dashboard confirmed saved credentials were deleted, and the setup AP remained accessible at `http://192.168.4.1`. Local setup-page provisioning was then used successfully.

## LCD and notice delivery

- [ ] Test empty, 1-character, 16-character, 17-character, and 200-character notices; reject 201 characters.
- [~] Verify first character, left alignment, 5-second first-frame hold, scrolling, trailing blank frame, and restart position. Notice display started at character 1 in Serial Monitor; a full boundary/scroll-timing test was not recorded.
- [x] Verify actual LCD output in addition to the dashboard acknowledgment. Owner confirmed test notices appeared on the physical LCD, including after Wi-Fi reconfiguration and power-cycle recovery.

## TLS and OTA

- [~] Confirm the device rejects invalid/untrusted TLS and connects to the backend using verified WSS after network-time synchronization. Successful secure WebSocket connection and device authentication were observed after the time-validation step. Invalid/untrusted TLS rejection was not tested, and explicit NTP synchronization confirmation was not recorded.
- [ ] Publish a signed release only after checking version, asset URL, size, digest, and signature independently. No release was published.
- [ ] Verify a valid update downloads, installs, reboots, and reports the expected version to the backend. OTA is disabled and was not tested.
- [ ] Test same-version, downgrade, invalid signature, modified image, mismatched size, TLS failure, and unavailable release. None may install. Not tested.
- [ ] Verify the previous application remains recoverable after a failed or interrupted update; document the observed boot/rollback behavior. Not tested.

## Deployment and evidence

- [x] Confirm dashboard login, authentication, notice delivery, Wi-Fi status, and firmware-version reporting against the deployed backend. Owner-reported dashboard status showed Backend Online, ESP32 Online, WebSocket Online, Wi-Fi Connected, device IP, RSSI, and firmware version `1.0.0`; notice delivery to the LCD was confirmed.
- [~] Record exact serial output and test results without including tokens, passwords, or private signing material. Relevant serial output was supplied and summarized in this report; a complete timestamped evidence log was not retained here.
- [x] Update `TEST_REPORT.md` with actual outcomes. The updated report distinguishes owner-reported physical observations from previously reported automated/build results. Continue to keep untested cases marked as pending.

## Physical observations recorded

- AP and local HTTP server started successfully.
- Local Wi-Fi setup page opened and accepted valid network credentials.
- ESP32 obtained an IP address, synchronized sufficiently to proceed through the TLS validation stage, connected to the deployed backend using WSS, and authenticated.
- Dashboard notice was received and displayed on the physical LCD.
- Remote Wi-Fi configuration changed the network; the ESP32 reconnected and authenticated with the backend.
- Forget saved Wi-Fi removed the saved credentials while keeping the setup AP available; local provisioning worked afterward.
- Power-cycle test: after approximately 10 seconds without power, the ESP32 restarted, reconnected, authenticated, and displayed a new notice.

## Remaining high-priority physical tests

1. Verify the board model, 4 MiB flash, partition table, and non-default AP password.
2. Test wrong password, unavailable SSID, and remote Wi-Fi configuration failure/rollback.
3. Test router outage/recovery and blocked-NTP behavior.
4. Test notice length boundaries and all scrolling timing/blank-frame behavior.
5. Test invalid TLS rejection.
6. Keep OTA tests pending until OTA is deliberately enabled and a properly signed test release is prepared.

**Important:** Results above are based on owner-reported physical observations and the Serial Monitor excerpts supplied. They do not imply that untested negative paths, partition migration, or OTA behavior have been validated.
