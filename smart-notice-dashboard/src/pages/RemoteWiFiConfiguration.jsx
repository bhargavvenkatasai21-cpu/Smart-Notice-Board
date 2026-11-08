import { useRef, useState } from "react";
import {
  getRemoteWifiConfiguration,
  startRemoteWifiConfiguration,
} from "../services/esp32Service.js";

const TERMINAL_STATES = new Set(["authenticated", "failed", "timed_out"]);
const POLL_INTERVAL_MS = 1500;
const MAX_POLL_ATTEMPTS = 90;

const OPERATION_LABELS = {
  command_sent: "Sending configuration to the ESP32…",
  accepted: "ESP32 accepted the configuration…",
  connecting: "ESP32 is connecting to the Wi-Fi network…",
  wifi_connected: "Wi-Fi connected; verifying backend reconnection…",
  authenticated: "Wi-Fi connected and ESP32 authenticated with the backend.",
  failed: "Wi-Fi configuration failed.",
  timed_out: "The configuration result could not be confirmed in time.",
};

function formatLastConnected(value) {
  if (!value) return "Not reported";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Not reported" : date.toLocaleString();
}

function waitForNextPoll() {
  return new Promise((resolve) => window.setTimeout(resolve, POLL_INTERVAL_MS));
}

function RemoteWiFiConfiguration({
  sessionToken,
  deviceConnected,
  wifiStatus,
  onConfigured,
}) {
  const [ssid, setSsid] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [operation, setOperation] = useState(null);
  const [error, setError] = useState("");
  const submitting = useRef(false);

  const handleSubmit = async (event) => {
    event.preventDefault();
    if (submitting.current) return;
    submitting.current = true;
    setBusy(true);
    setOperation(null);
    setError("");

    try {
      const started = await startRemoteWifiConfiguration(
        sessionToken,
        ssid,
        password,
      );
      let latestOperation = null;
      for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS; attempt += 1) {
        await waitForNextPoll();
        latestOperation = await getRemoteWifiConfiguration(
          sessionToken,
          started.requestId,
        );
        setOperation(latestOperation);
        if (TERMINAL_STATES.has(latestOperation.state)) break;
      }

      if (latestOperation?.state === "authenticated") {
        setSsid("");
        await onConfigured();
      } else if (latestOperation?.state === "failed" || latestOperation?.state === "timed_out") {
        setError(latestOperation.message || OPERATION_LABELS[latestOperation.state]);
      } else {
        setError(
          "The ESP32 has not reconnected yet. Check its status before trying again.",
        );
      }
    } catch (requestError) {
      setError(requestError.message || "Unable to configure ESP32 Wi-Fi.");
    } finally {
      setPassword("");
      setShowPassword(false);
      setBusy(false);
      submitting.current = false;
    }
  };

  return (
    <section aria-labelledby="remote-wifi-title" className="remote-wifi-page">
      <div className="page-intro">
        <div>
          <p className="eyebrow">DEVICE NETWORK</p>
          <h2 id="remote-wifi-title">ESP32 Wi-Fi configuration</h2>
          <p>
            Send network credentials securely through the authenticated
            dashboard connection. The ESP32 keeps its setup access point
            available during the change.
          </p>
        </div>
      </div>

      <div className="wifi-grid">
        <section className="card config-card">
          <div className="card-heading">
            <div>
              <p className="eyebrow">NETWORK ACCESS</p>
              <h3>Connect ESP32 to Wi-Fi</h3>
            </div>
            <span className="card-icon" aria-hidden="true">⌁</span>
          </div>

          <form onSubmit={handleSubmit}>
            <label htmlFor="remote-wifi-ssid">Wi-Fi network name (SSID)</label>
            <input
              autoComplete="username"
              id="remote-wifi-ssid"
              maxLength={32}
              onChange={(event) => setSsid(event.target.value)}
              placeholder="Enter your network name"
              required
              value={ssid}
            />

            <label htmlFor="remote-wifi-password">Wi-Fi password</label>
            <div className="password-field">
              <input
                autoComplete="new-password"
                id="remote-wifi-password"
                maxLength={63}
                onChange={(event) => setPassword(event.target.value)}
                placeholder="Leave empty for an open network"
                type={showPassword ? "text" : "password"}
                value={password}
              />
              <button
                aria-label={showPassword ? "Hide Wi-Fi password" : "Show Wi-Fi password"}
                aria-pressed={showPassword}
                className="password-toggle"
                onClick={() => setShowPassword((visible) => !visible)}
                type="button"
              >
                {showPassword ? "Hide" : "Show"}
              </button>
            </div>

            <button
              className="primary-button"
              disabled={busy || !deviceConnected}
              type="submit"
            >
              {busy
                ? "Configuring Wi-Fi…"
                : deviceConnected
                  ? "Connect to Wi-Fi"
                  : "ESP32 offline"}
            </button>
          </form>

          {operation && (busy || operation.state === "authenticated") && (
            <p
              className={`feedback ${operation.state === "authenticated" ? "success" : "info"}`}
              role="status"
              aria-live="polite"
            >
              {OPERATION_LABELS[operation.state] || "Checking ESP32 status…"}
            </p>
          )}
          {error && <p className="feedback error" role="alert">{error}</p>}
          {!deviceConnected && (
            <p className="feedback warning" role="status">
              The ESP32 is not currently connected to the backend. Remote
              configuration requires an active device connection.
            </p>
          )}
        </section>

        <section className="card connection-card" aria-labelledby="remote-wifi-status">
          <div className="card-heading">
            <div>
              <p className="eyebrow">CURRENT NETWORK</p>
              <h3 id="remote-wifi-status">ESP32 Wi-Fi status</h3>
            </div>
          </div>
          <div className="connection-summary">
            <span className={`header-status ${wifiStatus?.connected ? "is-online" : ""}`}>
              {wifiStatus?.connected ? "Connected" : "Not connected"}
            </span>
            <span className="poll-note">
              {deviceConnected ? "Reported by ESP32" : "ESP32 offline"}
            </span>
          </div>
          <dl className="device-details">
            <div>
              <dt>Network</dt>
              <dd>{wifiStatus?.ssid || "Not reported"}</dd>
            </div>
            <div>
              <dt>IP address</dt>
              <dd>{wifiStatus?.ip || "Not reported"}</dd>
            </div>
            <div>
              <dt>Last connection</dt>
              <dd>{formatLastConnected(wifiStatus?.lastConnectedAt)}</dd>
            </div>
          </dl>
          <p className="remote-wifi-note">
            A successful result means the ESP32 reconnected to the backend.
            Confirm Wi-Fi and LCD behavior on the physical board after setup.
          </p>
        </section>
      </div>
    </section>
  );
}

export default RemoteWiFiConfiguration;
