# Deployment notes

No Render configuration or production service was changed during this work.
Review the existing Render dashboard before making any deployment change.

## Backend Web Service

- Root directory: `backend`
- Build command: `npm install`
- Start command: `npm start`
- Keep a single instance: device connections, dashboard sessions, rate-limit
  counters, and operation state are in process memory.
- Configure `ESP32_DEVICE_TOKEN`, `DASHBOARD_ACCESS_CODE`, and
  `DASHBOARD_ORIGIN` as Render environment variables. Do not put them in
  frontend `VITE_*` settings.
- Optional timeouts are `NOTICE_ACK_TIMEOUT_MS`,
  `WIFI_CONFIGURATION_TIMEOUT_MS`, `WIFI_FORGET_TIMEOUT_MS`, and
  `FIRMWARE_UPDATE_TIMEOUT_MS`; their sample values are in
  `backend/.env.example`.
- Ensure the backend remains available at the host compiled into the firmware.
  Its WSS certificate chain must validate against `include/trust_roots.h`.

## Dashboard Static Site

- Root directory: `smart-notice-dashboard`
- Build command: `npm install && npm run build`
- Publish directory: `dist`
- Set `VITE_API_BASE_URL` to the HTTPS backend URL.
- Add the exact deployed dashboard origin to backend `DASHBOARD_ORIGIN`.
- Do not add the access code, device token, Wi-Fi passwords, or OTA private key
  to the frontend environment.

## Release and approval boundaries

Do not push commits, publish a GitHub release, change Render settings, or deploy
without explicit owner approval. Follow [OTA_RELEASES.md](./OTA_RELEASES.md)
for signed release assets and [HARDWARE_TEST_CHECKLIST.md](./HARDWARE_TEST_CHECKLIST.md)
before physical rollout.
