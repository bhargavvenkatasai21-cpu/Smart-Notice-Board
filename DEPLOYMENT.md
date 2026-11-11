# Deployment notes

No Render configuration or production service was changed during this work.
Review the existing Render dashboard before making any deployment change.

## Backend Web Service

- Root directory: `backend`
- Build command: `npm install`
- Start command: `npm start`
- Keep a single instance: device connections, rate-limit counters, and
  operation state are process-local. Configure a persistent disk for dashboard
  sessions; the session store is file-backed, not shared between instances.
- Configure `ESP32_DEVICE_TOKEN`, `DASHBOARD_ACCESS_CODE`, and
  `DASHBOARD_ORIGIN` as Render environment variables. Do not put them in
  frontend `VITE_*` settings.
- Attach a Render persistent disk mounted at `/var/data`, then set
  `DASHBOARD_SESSION_STORE_PATH=/var/data/dashboard-sessions.json`. Production
  startup fails if this path is not configured. Do not use an ephemeral
  filesystem path for sessions: a redeploy or restart would invalidate them.
- Use one backend instance with this disk-backed session file. The file stores
  only hashed session tokens and expiration metadata. Back it up/protect it
  like other authentication state. Do not mount the same JSON session file
  read-write into multiple service instances.
- Optional timeouts are `NOTICE_ACK_TIMEOUT_MS`,
  `WIFI_CONFIGURATION_TIMEOUT_MS`, `WIFI_FORGET_TIMEOUT_MS`, and
  `FIRMWARE_UPDATE_TIMEOUT_MS` / `FIRMWARE_CHECK_TIMEOUT_MS`; their sample
  values are in `backend/.env.example`.
- Ensure the backend remains available at the host compiled into the firmware.
  Its WSS certificate chain must validate against `include/trust_roots.h`.

## Dashboard Static Site

- Root directory: `smart-notice-dashboard`
- Build command: `npm install && npm run build`
- Publish directory: `dist`
- Set `VITE_API_BASE_URL` to the HTTPS backend URL.
- Add the exact deployed dashboard origin to backend `DASHBOARD_ORIGIN`.
- The dashboard uses an HttpOnly cookie; allow credentialed requests from the
  exact dashboard origin. The backend sets Secure cookies in production and
  uses SameSite=None for cross-origin HTTPS dashboard/API deployments.
- Do not add the access code, device token, Wi-Fi passwords, or OTA private key
  to the frontend environment.

## Release and approval boundaries

Do not push commits, publish a GitHub release, change Render settings, or deploy
without explicit owner approval. Follow [OTA_RELEASES.md](./OTA_RELEASES.md)
for signed release assets and [HARDWARE_TEST_CHECKLIST.md](./HARDWARE_TEST_CHECKLIST.md)
before physical rollout.

## What must be deployed or flashed

- Backend changes (cookie sessions, persistent store, and firmware-check API)
  require a backend redeploy and the persistent-disk environment setting above.
- Dashboard changes require a Static Site rebuild/deploy. No access code,
  device token, or signing key belongs in frontend settings.
- Firmware changes (release discovery, check/install protocol, diagnostics,
  and Wi-Fi recovery) require a PlatformIO build and USB flash to upgrade a
  device that does not already run this implementation. OTA cannot add OTA
  support to an older image. Once the device has the OTA-capable firmware and
  matching public trust key, later signed releases can use the OTA process.
- The firmware version is supplied at build time with
  `BOARD_FIRMWARE_VERSION=major.minor.patch`; changing the release number does
  not require editing C++ source.
