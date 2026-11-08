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
- `DASHBOARD_ACCESS_CODE`: code entered on the dashboard login form. The
  backend validates it and issues an opaque dashboard session; the access code
  is never included in the frontend bundle.
- `DASHBOARD_ORIGIN`: exact dashboard origin(s), comma-separated (include the
  deployed Render Static Site origin and any local development origin).
- `PORT`: optional; Render assigns this automatically.
- `NOTICE_ACK_TIMEOUT_MS`: optional acknowledgment timeout; defaults to 10000.

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

The backend reports a notice as delivered only after the ESP32 acknowledges
processing its display command. The acknowledgment confirms the firmware ran
the LCD display routine; the system cannot independently sense whether the LCD
physically rendered the characters.
