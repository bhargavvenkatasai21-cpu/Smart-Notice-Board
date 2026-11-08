# Smart Notice Board

ESP32-based notice display with a React dashboard and a Node.js API. The
dashboard sends notices to the backend; the backend forwards them over the
authenticated ESP32 WebSocket connection and waits for a device acknowledgment.

## Architecture

- `src/main.cpp`: ESP32 firmware, local HTTP Wi-Fi provisioning, LCD display,
  and authenticated secure WebSocket connection to the backend.
- `src/firmware_update.cpp`: signed, HTTPS-delivered OTA firmware updates.
- `backend/server.js`: Express API and `/ws` endpoint.
- `smart-notice-dashboard/`: React 19 + Vite dashboard.

Production notices and device status go through the HTTPS backend. The browser
does not call ESP32 HTTP endpoints from the deployed site. Local Wi-Fi setup is
available only from the Vite development server over HTTP.

## Remote Wi-Fi reconfiguration

After the ESP32 has been provisioned locally and is connected to the backend,
sign in to the dashboard and open **Wi-Fi configuration**. The dashboard sends
the new credentials to the authenticated backend over HTTPS; the backend
forwards them to the authenticated ESP32 WebSocket connection. The browser
does not store the Wi-Fi password, and the operation status API never returns
it.

The firmware keeps the setup access point available, attempts the new network,
and saves the new credentials only after the ESP32 reconnects and authenticates
with the backend. If the attempt fails, it tries to restore the previous saved
network. Remote configuration requires an already-connected ESP32 and saved
credentials; use the local setup access point for first-time provisioning.
If the ESP32 cannot reconnect to the backend, its Wi-Fi result may be
uncertain; check the device through its setup access point.

The dashboard can also request **Forget saved Wi-Fi**. After explicit
confirmation, the device verifies that NVS credentials were deleted, reports
the result, and then disconnects its station while keeping the setup access
point online.

The backend keeps active device coordination and operation results in memory.
Run a single backend instance: multiple instances do not share device
connections or Wi-Fi operation state. ESP32 Wi-Fi credentials are stored in
Preferences/NVS without application-level encryption; protect physical access
to the board and use a trusted network.

## Signed firmware updates

The dashboard can request a signed update from the device. Firmware downloads
use verified HTTPS and a GitHub Release manifest; the ESP32 verifies the
Ed25519 signature, version, image size, SHA-256 digest, and ESP32 image before
activating the OTA slot. The backend reports an update as verified only after
the device reboots and reports the expected version.

OTA is intentionally disabled until the owner embeds their own Ed25519 public
key in `include/ota_config.h`. No private key is in this repository; keep it
offline and outside the repository. See [OTA_RELEASES.md](./OTA_RELEASES.md)
for the release process and [SECURITY.md](./SECURITY.md) for limitations.
Application version checks do not provide Secure Boot, eFuse anti-rollback,
or hardware-root-of-trust protection.

## Partition layout and migration

The custom 4 MiB table provides two 1,507,328-byte OTA application slots and a
1 MiB SPIFFS partition. The table changes the SPIFFS offset/size; a manual USB
migration requires a full flash erase and therefore erases saved Wi-Fi
credentials in NVS. Do not run the migration until you have physical access
and can provision the device again. See [PARTITION_MIGRATION.md](./PARTITION_MIGRATION.md).

## Security and deployment

Development builds retain the legacy `12345678` setup-AP password if
`BOARD_AP_PASSWORD` is not set in the ignored `include/secrets.h`; firmware
prints a warning in that case. PlatformIO blocks firmware upload unless that
header defines a custom, non-default 8–63 byte password. Configure a unique
password before flashing a board.
Render deployment settings and the single-instance limitation are documented
in [DEPLOYMENT.md](./DEPLOYMENT.md). No Render settings were changed.

## Configuration

Copy `smart-notice-dashboard/.env.example` to
`smart-notice-dashboard/.env.local` and set `VITE_API_BASE_URL` to the backend
HTTPS URL. This URL is public configuration, not a secret.

Configure these backend environment variables in the local environment or
Render service settings:

- `ESP32_DEVICE_TOKEN`: shared only by the backend and ESP32 firmware.
- `DASHBOARD_ACCESS_CODE`: code entered on the dashboard login form. The
  backend validates it and issues an opaque dashboard session; the access code
  is never included in the frontend bundle.
- `DASHBOARD_ORIGIN`: exact dashboard origin(s), comma-separated (include the
  deployed Render Static Site origin and any local development origin).
- `PORT`: optional; Render assigns this automatically.
- `NOTICE_ACK_TIMEOUT_MS`: optional acknowledgment timeout; defaults to 10000.
- `WIFI_CONFIGURATION_TIMEOUT_MS`: optional remote network configuration
  timeout; defaults to 120000.
- `WIFI_FORGET_TIMEOUT_MS`: optional credential-deletion confirmation timeout;
  defaults to 10000.
- `FIRMWARE_UPDATE_TIMEOUT_MS`: optional OTA completion timeout; defaults to
  300000.

Keep the access code and device token in untracked backend environment
settings. Do not place credentials in a `VITE_*` variable: Vite embeds those
values in publicly downloadable JavaScript. The dashboard exchanges the code
for an opaque server-side session. Sessions expire after 12 hours by default
or 30 days when “Remember me” is selected; logout revokes the current session.
Remember me stores only the session token in `localStorage`, not the access
code. JavaScript running on the dashboard origin can read local storage, so
avoid shared devices and protect the site against cross-site scripting.

The configured access code is short and guessable. Backend validation keeps
it out of the frontend bundle, but does not make the code itself strong; use
this shared code only for a trusted/demo deployment. For internet-facing or
multi-user access, use a long random code or individual authentication.
Sessions are held in backend memory and are invalidated when the backend
restarts or is redeployed; this in-memory session store is not shared across
multiple backend instances.

## Run locally

Start the backend after setting its environment variables:

```powershell
Set-Location D:\iot\Smart-Notice-Board\backend
npm install
npm start
```

In another terminal:

```powershell
Set-Location D:\iot\Smart-Notice-Board\smart-notice-dashboard
npm install
npm run dev
```

For local Wi-Fi provisioning, connect the computer or phone to the
`SmartNoticeBoard` access point (use `BOARD_AP_PASSWORD` from
`include/secrets.h`, or the warned legacy fallback `12345678` in a development
build), then open the Vite dashboard over HTTP. Submit the router credentials
and switch back to the router Wi-Fi when the ESP32 reports its IP. A browser
cannot switch networks automatically.
Guest Wi-Fi or client isolation may block local device access.

## Tests and builds

```powershell
Set-Location D:\iot\Smart-Notice-Board\smart-notice-dashboard
npm test
npm run lint
npm run build

Set-Location D:\iot\Smart-Notice-Board\backend
npm test

Set-Location D:\iot\Smart-Notice-Board
C:\Users\bharg\.platformio\penv\Scripts\pio.exe run
```

Backend integration tests use a simulated WebSocket device. They do not replace
flashing the firmware or verifying the LCD, Wi-Fi behavior, TLS connectivity,
or OTA on actual hardware. See
[HARDWARE_TEST_CHECKLIST.md](./HARDWARE_TEST_CHECKLIST.md).

## Deploy

1. Deploy `backend/` as a Render Web Service with `npm install` and `npm start`.
2. Set `ESP32_DEVICE_TOKEN`, `DASHBOARD_ACCESS_CODE`, and `DASHBOARD_ORIGIN` in
   the backend's Render environment. Set `DASHBOARD_ORIGIN` to the exact
   deployed Static Site origin. Set `DASHBOARD_ACCESS_CODE` to the required
   access code in Render's backend environment settings; do not add it to the
   frontend service.
3. Configure the dashboard Static Site with root directory
   `smart-notice-dashboard`, build command `npm install && npm run build`, and
   publish directory `dist`.
4. Set `VITE_API_BASE_URL=https://smart-notice-board-api.onrender.com` for the
   Static Site, then redeploy. Do not configure the dashboard access code as a
   `VITE_*` variable.
5. Flash the firmware with its private device token configured in the ignored
   `include/secrets.h` file and verify its secure WebSocket authentication.
6. Sign in to the dashboard with the configured access code, then check
   backend, device, and WebSocket status before sending a notice.
7. Once the device is online, use the dashboard's **Wi-Fi configuration** page
   to reconfigure its network remotely. Confirm a successful operation reports
   the ESP32's backend reconnection; verify the new network on the physical
   device.

The backend reports a notice as delivered only after the ESP32 acknowledges
processing its display command. The acknowledgment confirms the firmware ran
the LCD display routine; the system cannot independently sense whether the LCD
physically rendered the characters.
