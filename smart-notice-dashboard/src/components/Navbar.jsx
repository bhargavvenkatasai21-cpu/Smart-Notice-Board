function Navbar({ activePage, showSetup, showRemoteWifi, onNavigate }) {
  return (
    <nav className="page-nav" aria-label="Dashboard pages">
      <button
        aria-current={activePage === "dashboard" ? "page" : undefined}
        className={`nav-item ${activePage === "dashboard" ? "is-active" : ""}`}
        onClick={() => onNavigate("dashboard")}
        type="button"
      >
        Dashboard
      </button>
      {showSetup && (
        <button
          aria-current={activePage === "setup" ? "page" : undefined}
          className={`nav-item ${activePage === "setup" ? "is-active" : ""}`}
          onClick={() => onNavigate("setup")}
          type="button"
        >
          Device setup
        </button>
      )}
      {showRemoteWifi && (
        <button
          aria-current={activePage === "wifi" ? "page" : undefined}
          className={`nav-item ${activePage === "wifi" ? "is-active" : ""}`}
          onClick={() => onNavigate("wifi")}
          type="button"
        >
          Wi-Fi configuration
        </button>
      )}
    </nav>
  );
}

export default Navbar;
