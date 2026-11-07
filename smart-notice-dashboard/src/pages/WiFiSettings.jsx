import { useState } from "react";
import LoadingSpinner from "../components/LoadingSpinner.jsx";
import StatusBadge from "../components/StatusBadge.jsx";
import "../styles/WiFiSettings.css";

function WiFiSettings({
  wifiStatus,
  statusError,
  statusLoaded,
  connectionFeedback,
  deviceAddress,
  onConnect,
  onDisconnect,
  onReconnect,
  onSaveDeviceAddress,
}) {
  const [ssid, setSsid] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [busyAction, setBusyAction] = useState("");
  const [feedback, setFeedback] = useState(null);
  const [deviceAddressInput, setDeviceAddressInput] = useState(deviceAddress);

  const runAction = async (action, operation, fallbackMessage) => {
    setBusyAction(action);
    setFeedback(null);

    try {
      const result = await operation();
      setFeedback({
        kind: "success",
        message: result?.message || fallbackMessage,
      });
    } catch (error) {
      setFeedback({
        kind: "error",
        message: error.message || "The Wi-Fi request failed.",
      });
    } finally {
      setBusyAction("");
    }
  };

  const handleSubmit = (event) => {
    event.preventDefault();
    if (!ssid.trim()) {
      setFeedback({ kind: "error", message: "Enter a Wi-Fi network name." });
      return;
    }
    if (ssid.length > 32) {
      setFeedback({ kind: "error", message: "Wi-Fi network names can be at most 32 characters." });
      return;
    }
    if (password && (password.length < 8 || password.length > 63)) {
      setFeedback({
        kind: "error",
        message: "Use a Wi-Fi password between 8 and 63 characters, or leave it empty for an open network.",
      });
      return;
    }

    void runAction(
      "connect",
      () => onConnect(ssid, password),
      "Wi-Fi connection started.",
    );
  };

  const handleDeviceAddressSubmit = (event) => {
    event.preventDefault();
    void runAction(
      "deviceAddress",
      async () => {
        const result = await onSaveDeviceAddress(deviceAddressInput);
        if (result.address) {
          setDeviceAddressInput(result.address);
        }
        return result;
      },
      "ESP32 address saved.",
    );
  };

  const status = statusError
    ? "unreachable"
    : !statusLoaded
      ? "checking"
    : wifiStatus.connecting
      ? "connecting"
      : wifiStatus.connected
        ? "connected"
        : "disconnected";

  return (
    <>
      <section className="page-intro">
        <div>
          <p className="eyebrow">DEVICE SETUP</p>
          <h2>Wi-Fi configuration</h2>
          <p>Connect your board to a Wi-Fi network to manage its display.</p>
        </div>
        <div className="device-chip">
          <span className="device-chip-label">ESP32 ADDRESS</span>
          <strong>{wifiStatus.ip || deviceAddress}</strong>
        </div>
      </section>

      <div className="wifi-grid">
        <section className="card config-card">
          <div className="card-heading">
            <div>
              <p className="eyebrow">NETWORK ACCESS</p>
              <h3>Connect to Wi-Fi</h3>
            </div>
            <span className="card-icon" aria-hidden="true">⌁</span>
          </div>

          <form className="device-address-form" onSubmit={handleDeviceAddressSubmit}>
            <label htmlFor="device-address">ESP32 address (IP or host name)</label>
            <input
              autoComplete="url"
              id="device-address"
              onChange={(event) => setDeviceAddressInput(event.target.value)}
              placeholder="192.168.4.1"
              value={deviceAddressInput}
            />
            <button
              className="outline-button"
              disabled={Boolean(busyAction)}
              type="submit"
            >
              {busyAction === "deviceAddress" ? (
                <LoadingSpinner compact label="Checking address…" />
              ) : (
                "Save address and check"
              )}
            </button>
          </form>

          <form onSubmit={handleSubmit}>
            <label htmlFor="wifi-ssid">Wi-Fi network name (SSID)</label>
            <input
              autoComplete="username"
              id="wifi-ssid"
              maxLength={32}
              onChange={(event) => setSsid(event.target.value)}
              placeholder="Enter your network name"
              value={ssid}
            />

            <label htmlFor="wifi-password">Wi-Fi password</label>
            <div className="password-field">
              <input
                autoComplete="new-password"
                id="wifi-password"
                maxLength={63}
                onChange={(event) => setPassword(event.target.value)}
                placeholder="Enter your password"
                type={showPassword ? "text" : "password"}
                value={password}
              />
              <button
                aria-label={showPassword ? "Hide password" : "Show password"}
                className="password-toggle"
                onClick={() => setShowPassword((visible) => !visible)}
                type="button"
              >
                {showPassword ? "Hide" : "Show"}
              </button>
            </div>

            <button className="primary-button" disabled={Boolean(busyAction)} type="submit">
              {busyAction === "connect" ? (
                <LoadingSpinner compact label="Connecting…" />
              ) : (
                "Connect to Wi-Fi"
              )}
            </button>
          </form>

          {feedback && (
            <p className={`feedback ${feedback.kind}`} role="status">
              {feedback.message}
            </p>
          )}
          {connectionFeedback && (
            <p className={`feedback ${connectionFeedback.kind}`} role="status">
              {connectionFeedback.message}
            </p>
          )}
          {statusError && <p className="feedback error" role="alert">{statusError}</p>}
        </section>

        <section className="card connection-card">
          <div className="card-heading">
            <div>
              <p className="eyebrow">LIVE DEVICE STATUS</p>
              <h3>Connection</h3>
            </div>
            <span className={`connection-pulse status-${status}`} aria-hidden="true" />
          </div>

          <div className="connection-summary">
            <StatusBadge status={status} />
            <span className="poll-note">Refreshes every 4 seconds</span>
          </div>

          <dl className="device-details">
            <div>
              <dt>Wi-Fi network</dt>
              <dd>{wifiStatus.ssid || "Not connected"}</dd>
            </div>
            <div>
              <dt>Device IP address</dt>
              <dd>{wifiStatus.ip || "Unavailable"}</dd>
            </div>
            {wifiStatus.apIp && (
              <div>
                <dt>Setup access point</dt>
                <dd>{wifiStatus.apIp}</dd>
              </div>
            )}
          </dl>

          <div className="action-row">
            <button
              className="secondary-button"
              disabled={Boolean(busyAction)}
              onClick={() =>
                void runAction(
                  "disconnect",
                  async () => {
                    const result = await onDisconnect();
                    if (result?.reconnectAddress) {
                      setDeviceAddressInput(result.reconnectAddress);
                    }
                    return result;
                  },
                  "Disconnected. Saved Wi-Fi details were kept.",
                )
              }
              type="button"
            >
              {busyAction === "disconnect" ? (
                <LoadingSpinner compact label="Disconnecting…" />
              ) : (
                "Disconnect"
              )}
            </button>
            <button
              className="outline-button"
              disabled={Boolean(busyAction)}
              onClick={() =>
                void runAction(
                  "reconnect",
                  onReconnect,
                  "Reconnection to the saved network started.",
                )
              }
              type="button"
            >
              {busyAction === "reconnect" ? (
                <LoadingSpinner compact label="Reconnecting…" />
              ) : (
                "Reconnect"
              )}
            </button>
          </div>
        </section>
      </div>
    </>
  );
}

export default WiFiSettings;
