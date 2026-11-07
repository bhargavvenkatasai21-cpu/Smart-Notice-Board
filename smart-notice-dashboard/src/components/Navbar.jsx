function Navbar({ activePage, isConnected, onNavigate }) {
  return (
    <nav className="page-nav" aria-label="Dashboard pages">
      <button
        className={`nav-item ${activePage === "wifi" ? "is-active" : ""}`}
        onClick={() => onNavigate("wifi")}
        type="button"
      >
        <span className="nav-step">01</span>
        Wi-Fi Settings
      </button>
      <span className="nav-divider" aria-hidden="true" />
      <button
        aria-disabled={!isConnected}
        className={`nav-item ${activePage === "notice" ? "is-active" : ""}`}
        disabled={!isConnected}
        onClick={() => onNavigate("notice")}
        type="button"
      >
        <span className="nav-step">02</span>
        Send Notice
      </button>
    </nav>
  );
}

export default Navbar;
