import { useState } from "react";
import LoadingSpinner from "../components/LoadingSpinner.jsx";
import StatusBadge from "../components/StatusBadge.jsx";
import { sendNotice } from "../services/esp32Service.js";
import "../styles/SendNotice.css";

function SendNotice({
  wifiStatus,
  statusError,
  statusLoaded,
  deviceAddress,
  refreshStatus,
  onNavigate,
}) {
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState(null);

  const connected = wifiStatus.connected && !statusError;
  const status = statusError
    ? "unreachable"
    : !statusLoaded
      ? "checking"
    : wifiStatus.connecting
      ? "connecting"
      : connected
        ? "connected"
        : "disconnected";

  const handleSubmit = async (event) => {
    event.preventDefault();
    if (!notice.trim()) {
      setFeedback({ kind: "error", message: "Enter a notice before sending." });
      return;
    }

    setBusy(true);
    setFeedback(null);

    try {
      const latestStatus = await refreshStatus();
      if (!latestStatus) {
        throw new Error("Cannot verify the ESP32 connection. Check its network access and try again.");
      }
      if (!latestStatus.connected) {
        throw new Error("The ESP32 is disconnected. Reconnect before sending a notice.");
      }

      const result = await sendNotice(notice);
      setFeedback({
        kind: "success",
        message: result?.message || "Notice sent to the display.",
      });
    } catch (error) {
      setFeedback({
        kind: "error",
        message: error.message || "Unable to send the notice.",
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <section className="page-intro">
        <div>
          <p className="eyebrow">NOTICE MANAGEMENT</p>
          <h2>Send a notice</h2>
          <p>Send an announcement directly to your 16-character LCD.</p>
        </div>
        <div className="device-chip">
          <span className="device-chip-label">ESP32 ADDRESS</span>
          <strong>{wifiStatus.ip || deviceAddress}</strong>
        </div>
      </section>

      <section className="card notice-card">
        <div className="card-heading">
          <div>
            <p className="eyebrow">DISPLAY MESSAGE</p>
            <h3>Compose your notice</h3>
          </div>
          <span className="card-icon" aria-hidden="true">✦</span>
        </div>

        <form onSubmit={handleSubmit}>
          <label htmlFor="notice-message">Notice text</label>
          <textarea
            id="notice-message"
            maxLength={200}
            onChange={(event) => {
              setNotice(event.target.value);
              setFeedback(null);
            }}
            placeholder="Type the message you want to display on your notice board…"
            rows="7"
            value={notice}
          />
          <div className="textarea-meta">
            <span>Keep your message clear and easy to read (maximum 200 characters).</span>
            <span>{notice.length}/200 characters</span>
          </div>

          <div className="notice-actions">
            <button
              className="primary-button send-button"
              disabled={busy || !notice.trim() || !connected}
              type="submit"
            >
              {busy ? <LoadingSpinner compact label="Sending…" /> : "Send Notice"}
            </button>
            <button
              className="outline-button clear-button"
              onClick={() => {
                setNotice("");
                setFeedback(null);
              }}
              type="button"
            >
              Clear
            </button>
          </div>
        </form>

        {feedback && (
          <p className={`feedback ${feedback.kind}`} role="status">
            {feedback.message}
          </p>
        )}
        {!connected && (
          <p className="feedback error" role="status">
            {statusError
              ? "The ESP32 cannot be reached. Check the network connection."
              : statusLoaded
                ? "The ESP32 is disconnected. Reconnect from Wi-Fi Settings before sending."
                : "Checking the ESP32 connection…"}
          </p>
        )}

        <div className="notice-footer">
          <div className="mini-connection">
            <StatusBadge status={status} />
            <span className="mini-ip">{wifiStatus.ip || "IP unavailable"}</span>
          </div>
          <button
            className="text-button"
            onClick={() => onNavigate("wifi")}
            type="button"
          >
            ← Back to Wi-Fi Settings
          </button>
        </div>
      </section>
    </>
  );
}

export default SendNotice;
