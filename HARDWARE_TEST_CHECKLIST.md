# Physical hardware validation checklist

Automated tests and a successful PlatformIO build do not prove behavior on the
ESP32, access point, router, or LCD. Record the board, firmware version, date,
and results before declaring a test complete.

## Before flashing

- [ ] Confirm the ESP32 model has 4 MiB flash and the custom partition layout.
- [ ] Set a unique, non-default `BOARD_AP_PASSWORD` (8–63 bytes) in the
      ignored `include/secrets.h`; verify PlatformIO blocks upload without it.
- [ ] Confirm the device token matches the backend environment.
- [ ] If testing OTA, configure the owner's public key and verify the matching
      private key remains offline and outside the repository.
- [ ] Keep USB serial recovery available. Do not erase NVS unless prepared to
      re-enter router credentials.

## Wi-Fi and recovery

- [ ] Power up; verify AP and HTTP server startup in Serial Monitor.
- [ ] Confirm the setup AP password is not the legacy default.
- [ ] Provision valid Wi-Fi credentials; verify SSID is not printed to serial,
      the ESP32 obtains an IP, and backend status reports connected.
- [ ] Try an incorrect password and unavailable SSID; verify timeout, no
      failed candidate credential is saved, and setup AP remains responsive.
- [ ] Reboot and confirm saved credentials reconnect.
- [ ] Confirm NTP obtains valid time before WSS starts; test with NTP blocked
      and verify TLS remains closed while the setup AP stays available.
- [ ] Disconnect Wi-Fi, manually reconnect, stop and restore the router, and
      record recovery timing and RSSI.
- [ ] Remotely configure a new network; verify successful backend
      authentication before the new credentials become saved.
- [ ] Test remote configuration failure and verify the previous saved network
      remains available.
- [ ] Explicitly confirm **Forget saved Wi-Fi**; verify credentials are
      deleted and the setup AP remains available afterward.

## LCD and notice delivery

- [ ] Test empty, 1-character, 16-character, 17-character, and 200-character
      notices; reject 201 characters.
- [ ] Verify first character, left alignment, 5-second first-frame hold,
      scrolling, trailing blank frame, and restart position.
- [ ] Verify actual LCD output in addition to the dashboard acknowledgment.

## TLS and OTA

- [ ] Confirm the device rejects invalid/untrusted TLS and connects to the
      backend using verified WSS after network-time synchronization.
- [ ] Publish a signed release only after checking version, asset URL, size,
      digest, and signature independently.
- [ ] Verify a valid update downloads, installs, reboots, and reports the
      expected version to the backend.
- [ ] Test same-version, downgrade, invalid signature, modified image,
      mismatched size, TLS failure, and unavailable release. None may install.
- [ ] Verify the previous application remains recoverable after a failed or
      interrupted update; document the observed boot/rollback behavior.

## Deployment and evidence

- [ ] Confirm dashboard login, authentication, notice delivery, Wi-Fi status,
      operation polling, and firmware-version reporting against the deployed
      backend.
- [ ] Record exact serial output and test results without including tokens,
      passwords, or private signing material.
- [ ] Update `TEST_REPORT.md` with actual outcomes. Distinguish simulated tests,
      compile results, owner-reported results, and physical observations.
