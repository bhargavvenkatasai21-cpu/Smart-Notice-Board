const STATUS_LABELS = {
  connected: "Connected",
  disconnected: "Disconnected",
  connecting: "Connecting",
  checking: "Checking ESP32",
  unreachable: "ESP32 unreachable",
};

function StatusBadge({ status }) {
  const label = STATUS_LABELS[status] || STATUS_LABELS.unreachable;

  return (
    <div className={`header-status status-${status}`} role="status" aria-live="polite">
      <span className="status-dot" aria-hidden="true" />
      <span>{label}</span>
    </div>
  );
}

export default StatusBadge;
