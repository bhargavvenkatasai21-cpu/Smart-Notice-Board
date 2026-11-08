import "./../styles/Header.css";

function Header({ backendOnline, deviceConnected, deviceStatusKnown }) {
  const status =
    backendOnline === null
    ? "checking"
    : backendOnline
      ? "connected"
      : "unreachable";
  const backendLabel =
    backendOnline === null
    ? "Backend checking"
    : backendOnline
      ? "Backend online"
      : "Backend offline";

  return (
    <header className="app-header">
      <div className="header-inner">
        <div className="brand-mark" aria-hidden="true">SN</div>
        <div className="brand-copy">
          <p className="eyebrow">IoT DEVICE CONSOLE</p>
          <h1>SMART NOTICE BOARD</h1>
          <p className="header-subtitle">IoT-Based Wireless Notice Display System</p>
        </div>
        <div className={`header-status status-${status}`} aria-live="polite">
          <span className="status-dot" aria-hidden="true" />
          <span>{backendLabel}</span>
          <span className="header-device-status">
            {deviceStatusKnown
              ? `ESP32 ${deviceConnected ? "connected" : "disconnected"}`
              : "ESP32 status unknown"}
          </span>
        </div>
      </div>
    </header>
  );
}

export default Header;
