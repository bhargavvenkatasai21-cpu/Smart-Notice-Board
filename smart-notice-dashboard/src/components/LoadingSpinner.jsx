function LoadingSpinner({ label = "Loading", compact = false }) {
  return (
    <span className={`loading-indicator ${compact ? "is-compact" : ""}`} role="status">
      <span className="spinner" aria-hidden="true" />
      <span>{label}</span>
    </span>
  );
}

export default LoadingSpinner;
