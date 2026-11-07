import StatusBadge from "./StatusBadge.jsx";
import "./../styles/Header.css";

function Header({ wifiStatus, statusError, statusLoaded }) {
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
    <header className="app-header">
      <div className="header-inner">
        <div className="brand-mark" aria-hidden="true">SN</div>
        <div className="brand-copy">
          <p className="eyebrow">IoT DEVICE CONSOLE</p>
          <h1>SMART NOTICE BOARD</h1>
          <p className="header-subtitle">IoT-Based Wireless Notice Display System</p>
        </div>
        <StatusBadge status={status} />
      </div>
    </header>
  );
}

export default Header;
