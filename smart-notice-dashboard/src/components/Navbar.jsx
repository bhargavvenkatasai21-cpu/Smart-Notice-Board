function Navbar({ activePage, showSetup, onNavigate }) {
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
    </nav>
  );
}

export default Navbar;
