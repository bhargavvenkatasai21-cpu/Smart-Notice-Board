import { useState } from "react";
import LoadingSpinner from "../components/LoadingSpinner.jsx";
import StatusBadge from "../components/StatusBadge.jsx";
import "../styles/SendNotice.css";

function SendNotice({
  backendOnline,
  deviceError,
  deviceStatus,
  latestNotice,
  onSendNotice,
}) {
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState(null);
  const connected = backendOnline === true && deviceStatus?.connected === true;
  const status =
    backendOnline === false
      ? "unreachable"
      : backendOnline === null
        ? "checking"
        : deviceError
          ? "unreachable"
          : connected
            ? "connected"
            : "disconnected";

  const handleSubmit = async (event) => {
    event.preventDefault();
    if (busy) return;
    if (!notice.trim()) {
      setFeedback({ kind: "error", message: "Enter a notice before sending." });
      return;
    }

    setBusy(true);
    setFeedback(null);
    try {
      const result = await onSendNotice(notice);
      setFeedback({
        kind: "success",
        message:
          result.message ||
          "The ESP32 acknowledged the notice. LCD output cannot be sensed by the backend.",
      });
    } catch (error) {
      setFeedback({
        kind: "error",
        message: error.message || "Unable to deliver the notice.",
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
          <p>
            Send a message through the backend. Success is shown only after the
            connected ESP32 acknowledges it.
          </p>
        </div>
      </section>

      <section className="card notice-card">
        <div className="card-heading">
          <div>
            <p className="eyebrow">DISPLAY MESSAGE</p>
            <h3>Compose your notice</h3>
          </div>
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
            placeholder="Write a short announcement for your notice board"
            rows="6"
            value={notice}
          />
          <div className="textarea-meta">
            <span>Maximum 200 characters.</span>
            <span aria-live="polite">{notice.length}/200</span>
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
              disabled={busy || !notice}
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
          <p className={`feedback ${backendOnline === false || deviceError ? "error" : ""}`} role="status">
            {backendOnline === false
              ? "The backend is unavailable. Notice delivery is paused."
              : deviceError
                ? `Device status could not be verified: ${deviceError}`
                : backendOnline === null
                  ? "Checking backend availability…"
                  : "The ESP32 is disconnected. Reconnect it before sending a notice."}
          </p>
        )}

        {latestNotice?.notice && (
          <section className="latest-notice" aria-label="Latest delivered notice">
            <p className="eyebrow">LATEST ACKNOWLEDGED NOTICE</p>
            <p>{latestNotice.notice}</p>
            {latestNotice.sentAt && (
              <time dateTime={latestNotice.sentAt}>
                {new Date(latestNotice.sentAt).toLocaleString()}
              </time>
            )}
          </section>
        )}

        <div className="notice-footer">
          <div className="mini-connection">
            <StatusBadge status={status} />
          </div>
        </div>
      </section>
    </>
  );
}

export default SendNotice;
