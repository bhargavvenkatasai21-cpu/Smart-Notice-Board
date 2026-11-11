import { useRef, useState } from "react";
import {
  getFirmwareUpdate,
  getRemoteWifiConfiguration,
  getRemoteWifiForget,
  startRemoteWifiConfiguration,
  startFirmwareCheck,
  startFirmwareUpdate,
  startRemoteWifiForget,
} from "../services/esp32Service.js";

const TERMINAL_STATES = new Set(["authenticated", "failed", "timed_out"]);
const FORGET_TERMINAL_STATES = new Set(["deleted", "failed", "timed_out"]);
const FIRMWARE_TERMINAL_STATES = new Set([
  "verified",
  "available",
  "up_to_date",
  "failed",
  "timed_out",
]);
const POLL_INTERVAL_MS = 1500;
const MAX_POLL_ATTEMPTS = 90;
const MAX_FIRMWARE_POLL_ATTEMPTS = 190;

const OPERATION_LABELS = {
  command_sent: "Sending configuration to the ESP32…",
  accepted: "ESP32 accepted the configuration…",
  connecting: "ESP32 is connecting to the Wi-Fi network…",
  wifi_connected: "Wi-Fi connected; verifying backend reconnection…",
  authenticated: "Wi-Fi connected and ESP32 authenticated with the backend.",
  failed: "Wi-Fi configuration failed.",
  timed_out: "The configuration result could not be confirmed in time.",
  deleted: "Saved Wi-Fi credentials were deleted. The setup access point remains available.",
};

const FORGET_OPERATION_LABELS = {
  command_sent: "Sending credential deletion request to the ESP32…",
  accepted: "ESP32 accepted the credential deletion request…",
  deleted: OPERATION_LABELS.deleted,
  failed: "The ESP32 could not delete the saved Wi-Fi credentials.",
  timed_out: "The deletion result could not be confirmed in time.",
};

const FIRMWARE_OPERATION_LABELS = {
  command_sent: "Sending firmware operation to the ESP32…",
  checking: "Checking the signed GitHub firmware release…",
  available: "A newer signed firmware release is available.",
  downloading: "Downloading firmware over verified HTTPS…",
  verifying: "Verifying the signed firmware image…",
  rebooting: "Firmware installed; waiting for the ESP32 to reconnect…",
  verified: "The ESP32 reconnected with the updated firmware.",
  up_to_date: "The ESP32 already has the latest firmware.",
  failed: "The firmware update failed.",
  timed_out: "The firmware update could not be confirmed in time.",
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
  const [forgetOperation, setForgetOperation] = useState(null);
  const [forgetError, setForgetError] = useState("");
  const [confirmingForget, setConfirmingForget] = useState(false);
  const [firmwareOperation, setFirmwareOperation] = useState(null);
  const [firmwareError, setFirmwareError] = useState("");
  const [confirmingReinstall, setConfirmingReinstall] = useState(false);
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
        ssid,
        password,
      );
      let latestOperation = null;
      for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS; attempt += 1) {
        await waitForNextPoll();
        latestOperation = await getRemoteWifiConfiguration(
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

  const handleForget = async () => {
    if (submitting.current) return;
    submitting.current = true;
    setBusy(true);
    setForgetOperation(null);
    setForgetError("");

    try {
      const started = await startRemoteWifiForget();
      let latestOperation = null;
      for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS; attempt += 1) {
        await waitForNextPoll();
        latestOperation = await getRemoteWifiForget(
          started.requestId,
        );
        setForgetOperation(latestOperation);
        if (FORGET_TERMINAL_STATES.has(latestOperation.state)) break;
      }

      if (latestOperation?.state === "deleted") {
        await onConfigured();
      } else if (
        latestOperation?.state === "failed" ||
        latestOperation?.state === "timed_out"
      ) {
        setForgetError(
          latestOperation.message || "Wi-Fi credentials could not be deleted.",
        );
      } else {
        setForgetError(
          "The ESP32 has not confirmed deletion. Check its status before trying again.",
        );
      }
    } catch (requestError) {
      setForgetError(requestError.message || "Unable to delete Wi-Fi credentials.");
    } finally {
      setConfirmingForget(false);
      setBusy(false);
      submitting.current = false;
    }
  };

  const handleFirmwareCheck = async () => {
    if (submitting.current) return;
    submitting.current = true;
    setBusy(true);
    setFirmwareOperation(null);
    setFirmwareError("");

    try {
      const started = await startFirmwareCheck();
      let latestOperation = null;
      for (let attempt = 0; attempt < MAX_FIRMWARE_POLL_ATTEMPTS; attempt += 1) {
        await waitForNextPoll();
        latestOperation = await getFirmwareUpdate(
          started.requestId,
        );
        setFirmwareOperation(latestOperation);
        if (FIRMWARE_TERMINAL_STATES.has(latestOperation.state)) break;
      }

      if (latestOperation?.state === "failed" || latestOperation?.state === "timed_out") {
        setFirmwareError(
          latestOperation.message || FIRMWARE_OPERATION_LABELS[latestOperation.state],
        );
      } else if (!["available", "up_to_date"].includes(latestOperation?.state)) {
        setFirmwareError(
          "The ESP32 has not confirmed the release check. Check its status before trying again.",
        );
      }
    } catch (requestError) {
      setFirmwareError(
        requestError.message || "Unable to check for ESP32 firmware updates.",
      );
    } finally {
      setBusy(false);
      submitting.current = false;
    }
  };

  const handleFirmwareInstall = async (allowReinstall = false) => {
    if (submitting.current) return;
    submitting.current = true;
    setBusy(true);
    setFirmwareOperation(null);
    setFirmwareError("");

    try {
      const started = await startFirmwareUpdate(allowReinstall);
      let latestOperation = null;
      for (let attempt = 0; attempt < MAX_FIRMWARE_POLL_ATTEMPTS; attempt += 1) {
        await waitForNextPoll();
        latestOperation = await getFirmwareUpdate(started.requestId);
        setFirmwareOperation(latestOperation);
        if (FIRMWARE_TERMINAL_STATES.has(latestOperation.state)) break;
      }

      if (latestOperation?.state === "verified") {
        await onConfigured();
      } else if (
        latestOperation?.state === "failed" ||
        latestOperation?.state === "timed_out"
      ) {
        setFirmwareError(
          latestOperation.message || FIRMWARE_OPERATION_LABELS[latestOperation.state],
        );
      } else if (latestOperation?.state !== "up_to_date") {
        setFirmwareError(
          "The ESP32 has not confirmed installation. Check its status before trying again.",
        );
      }
    } catch (requestError) {
      setFirmwareError(
        requestError.message || "Unable to install ESP32 firmware.",
      );
    } finally {
      setBusy(false);
      setConfirmingReinstall(false);
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
            <div>
              <dt>Signal strength</dt>
              <dd>
                {Number.isInteger(wifiStatus?.rssi)
                  ? `${wifiStatus.rssi} dBm`
                  : "Not reported"}
              </dd>
            </div>
            <div>
              <dt>Firmware version</dt>
              <dd>{wifiStatus?.firmwareVersion || "Not reported"}</dd>
            </div>
          </dl>
          <div className="forget-wifi-controls">
            {!confirmingForget ? (
              <button
                className="secondary-button"
                disabled={busy || !deviceConnected}
                onClick={() => {
                  setForgetOperation(null);
                  setForgetError("");
                  setConfirmingForget(true);
                }}
                type="button"
              >
                Forget saved Wi-Fi
              </button>
            ) : (
              <div>
                <p className="feedback warning" role="status">
                  This permanently deletes saved Wi-Fi credentials from the
                  ESP32. Its setup access point will remain available.
                </p>
                <button
                  className="secondary-button"
                  disabled={busy || !deviceConnected}
                  onClick={() => void handleForget()}
                  type="button"
                >
                  {busy ? "Deleting credentials…" : "Confirm deletion"}
                </button>
                <button
                  className="secondary-button"
                  disabled={busy}
                  onClick={() => setConfirmingForget(false)}
                  type="button"
                >
                  Cancel
                </button>
              </div>
            )}
          </div>
          {forgetOperation && (
            <p
              className={`feedback ${forgetOperation.state === "deleted" ? "success" : "info"}`}
              role="status"
              aria-live="polite"
            >
              {FORGET_OPERATION_LABELS[forgetOperation.state] ||
                "Checking Wi-Fi credential deletion…"}
            </p>
          )}
          {forgetError && (
            <p className="feedback error" role="alert">{forgetError}</p>
          )}
          <div className="firmware-update-controls">
            <h4>Firmware updates</h4>
            <p>
              Check the latest stable signed release first. Installation is a
              separate action; reinstalling the same version requires explicit
              confirmation. Older versions are always rejected.
            </p>
            <button
              className="secondary-button"
              disabled={busy || !deviceConnected}
              onClick={() => void handleFirmwareCheck()}
              type="button"
            >
              {busy ? "Firmware operation in progress…" : "Check for signed update"}
            </button>
            {firmwareOperation?.state === "available" && (
              <button
                className="primary-button"
                disabled={busy || !deviceConnected}
                onClick={() => void handleFirmwareInstall()}
                type="button"
              >
                Install v{firmwareOperation.version}
              </button>
            )}
            {firmwareOperation?.state === "up_to_date" && !confirmingReinstall && (
              <button
                className="secondary-button"
                disabled={busy || !deviceConnected}
                onClick={() => setConfirmingReinstall(true)}
                type="button"
              >
                Reinstall current firmware
              </button>
            )}
            {confirmingReinstall && (
              <div>
                <p className="feedback warning" role="status">
                  This will intentionally reinstall the same signed firmware
                  version and reboot the ESP32.
                </p>
                <button
                  className="secondary-button"
                  disabled={busy || !deviceConnected}
                  onClick={() => void handleFirmwareInstall(true)}
                  type="button"
                >
                  {busy ? "Reinstalling…" : "Confirm reinstall"}
                </button>
                <button
                  className="secondary-button"
                  disabled={busy}
                  onClick={() => setConfirmingReinstall(false)}
                  type="button"
                >
                  Cancel
                </button>
              </div>
            )}
            {firmwareOperation && (
              <p
                className={`feedback ${
                  ["verified", "up_to_date"].includes(firmwareOperation.state)
                    ? "success"
                    : firmwareOperation.state === "failed" ||
                        firmwareOperation.state === "timed_out"
                      ? "error"
                      : "info"
                }`}
                role="status"
                aria-live="polite"
              >
                {FIRMWARE_OPERATION_LABELS[firmwareOperation.state] ||
                  "Checking firmware update status…"}
                {firmwareOperation.version
                  ? ` (v${firmwareOperation.version})`
                  : ""}
              </p>
            )}
            {firmwareError && (
              <p className="feedback error" role="alert">{firmwareError}</p>
            )}
          </div>
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
