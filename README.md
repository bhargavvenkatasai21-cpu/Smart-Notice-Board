# Smart Notice Board

ESP32-based notice display with a React dashboard and a Node.js API. The
dashboard sends notices to the backend; the backend forwards them over the
authenticated ESP32 WebSocket connection and waits for a device acknowledgment.

## Architecture

- `src/main.cpp`: ESP32 firmware, local HTTP Wi-Fi provisioning, LCD display,
  and authenticated secure WebSocket connection to the backend.
- `backend/server.js`: Express API and `/ws` endpoint.
- `smart-notice-dashboard/`: React 19 + Vite dashboard.

Production notices and device status go through the HTTPS backend. The browser
does not call ESP32 HTTP endpoints from the deployed site. Local Wi-Fi setup is
available only from the Vite development server over HTTP.

## Configuration

Copy `smart-notice-dashboard/.env.example` to
`smart-notice-dashboard/.env.local` and set `VITE_API_BASE_URL` to the backend
HTTPS URL. This URL is public configuration, not a secret.

Configure these backend environment variables in the local environment or
Render service settings:

- `ESP32_DEVICE_TOKEN`: shared only by the backend and ESP32 firmware.
- `DASHBOARD_API_TOKEN`: dashboard API bearer token.
- `DASHBOARD_ORIGIN`: exact dashboard origin(s), comma-separated (include the
  deployed Render Static Site origin and any local development origin).
- `PORT`: optional; Render assigns this automatically.
- `NOTICE_ACK_TIMEOUT_MS`: optional acknowledgment timeout; defaults to 10000.

Keep actual tokens in untracked environment settings. Do not place credentials
in a `VITE_*` variable: Vite embeds those values in publicly downloadable
JavaScript. The dashboard prompts for the shared dashboard token and keeps it
in memory only. This avoids bundling or persisting it but is still a shared
credential model; it does not provide per-user identity, revocation, or
individual audit trails. For a public production dashboard, replace it with
individual user authentication (for example, an OIDC provider and short-lived
server-side sessions) before granting access to multiple users.

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
`SmartNoticeBoard` access point (password `12345678`), then open the Vite
dashboard over HTTP. Submit the router credentials and switch back to the
router Wi-Fi when the ESP32 reports its IP. A browser cannot switch networks
automatically. Guest Wi-Fi or client isolation may block local device access.

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
flashing the firmware or verifying the LCD, Wi-Fi behavior, and network
connectivity on the actual hardware.

## Deploy

1. Deploy `backend/` as a Render Web Service with `npm install` and `npm start`.
2. Set `ESP32_DEVICE_TOKEN`, `DASHBOARD_API_TOKEN`, and `DASHBOARD_ORIGIN` in
   the backend's Render environment. Set `DASHBOARD_ORIGIN` to the exact
   deployed Static Site origin.
3. Configure the dashboard Static Site with root directory
   `smart-notice-dashboard`, build command `npm install && npm run build`, and
   publish directory `dist`.
4. Set `VITE_API_BASE_URL=https://smart-notice-board-api.onrender.com` for the
   Static Site, then redeploy. Do not configure a dashboard token as a
   `VITE_*` variable.
5. Flash the firmware with its private device token configured in the ignored
   `include/secrets.h` file and verify its secure WebSocket authentication.
6. Sign in to the dashboard with `DASHBOARD_API_TOKEN`, then check backend,
   device, and WebSocket status before sending a notice.

The backend reports a notice as delivered only after the ESP32 acknowledges
processing its display command. The acknowledgment confirms the firmware ran
the LCD display routine; the system cannot independently sense whether the LCD
physically rendered the characters.
