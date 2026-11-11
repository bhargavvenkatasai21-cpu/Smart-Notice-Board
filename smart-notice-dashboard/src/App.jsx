import { useCallback, useEffect, useRef, useState } from "react";
import Header from "./components/Header.jsx";
import Footer from "./components/Footer.jsx";
import Navbar from "./components/Navbar.jsx";
import SendNotice from "./pages/SendNotice.jsx";
import RemoteWiFiConfiguration from "./pages/RemoteWiFiConfiguration.jsx";
import WiFiSettings from "./pages/WiFiSettings.jsx";
import {
  connectWiFi,
  createDashboardSession,
  disconnectWiFi,
  getBackendHealth,
  getDashboardSession,
  getDeviceStatus,
  getESP32Address,
  getStatus,
  logoutDashboardSession,
  reconnectWiFi,
  sendNotice,
  setESP32Address,
} from "./services/esp32Service.js";
import "./styles/App.css";

const INITIAL_WIFI_STATUS = {
  connected: false,
  connecting: false,
  ip: "",
  ssid: "",
  apIp: "",
  savedCredentials: false,
  connectionError: "",
};
const STATUS_POLL_INTERVAL_MS = 15000;
const LOCAL_SETUP_AVAILABLE =
  import.meta.env?.DEV &&
  typeof window !== "undefined" &&
  window.location.protocol === "http:";

function formatLastCommunication(value) {
  if (!value) return "Not reported";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Not reported" : date.toLocaleString();
}

function App() {
  const [page, setPage] = useState("dashboard");
  const [dashboardAuthenticated, setDashboardAuthenticated] = useState(false);
  const [authInitialized, setAuthInitialized] = useState(false);
  const [authInitializationError, setAuthInitializationError] = useState("");
  const [accessCodeInput, setAccessCodeInput] = useState("");
  const [showAccessCode, setShowAccessCode] = useState(false);
  const [rememberSession, setRememberSession] = useState(false);
  const [authError, setAuthError] = useState("");
  const [authNotice, setAuthNotice] = useState("");
  const [authBusy, setAuthBusy] = useState(false);
  const [backendOnline, setBackendOnline] = useState(null);
  const [backendError, setBackendError] = useState("");
  const [deviceStatus, setDeviceStatus] = useState(null);
  const [deviceError, setDeviceError] = useState("");
  const [statusBusy, setStatusBusy] = useState(false);
  const [wifiStatus, setWifiStatus] = useState(INITIAL_WIFI_STATUS);
  const [wifiError, setWifiError] = useState("");
  const [wifiStatusLoaded, setWifiStatusLoaded] = useState(false);
  const [connectionFeedback, setConnectionFeedback] = useState(null);
  const [deviceAddress, setDeviceAddress] = useState(getESP32Address);
  const statusRequestId = useRef(0);
  const authInitializationId = useRef(0);

  const initializeAuthentication = useCallback(async () => {
    const requestId = ++authInitializationId.current;
    try {
      await getDashboardSession();
      if (requestId !== authInitializationId.current) return;
      setDashboardAuthenticated(true);
      setAuthNotice("");
      setAuthInitializationError("");
    } catch (error) {
      if (requestId !== authInitializationId.current) return;
      if (error?.status === 401) {
        setDashboardAuthenticated(false);
        setDeviceStatus(null);
        if (error.code === "session_invalid") {
          setAuthNotice("Your dashboard session expired or is no longer valid. Sign in again.");
        }
      } else {
        setAuthInitializationError(
          error?.message || "Unable to verify the dashboard session.",
        );
      }
    } finally {
      if (requestId === authInitializationId.current) {
        setAuthInitialized(true);
      }
    }
  }, []);

  useEffect(() => {
    let active = true;
    void Promise.resolve().then(() => {
      if (active) void initializeAuthentication();
    });
    return () => {
      active = false;
      authInitializationId.current += 1;
    };
  }, [initializeAuthentication]);

  const refreshBackendStatus = useCallback(
    async (isAuthenticated = dashboardAuthenticated) => {
      const requestId = ++statusRequestId.current;
      setStatusBusy(true);
      const [healthResult, deviceResult] = await Promise.allSettled([
        getBackendHealth(),
        isAuthenticated ? getDeviceStatus() : Promise.resolve(null),
      ]);

      const currentStatus = {
        backendOnline: healthResult.status === "fulfilled",
        deviceStatus:
          deviceResult.status === "fulfilled" ? deviceResult.value : null,
        backendError:
          healthResult.status === "rejected"
            ? healthResult.reason?.message || "Backend is unavailable."
            : "",
        deviceError:
          deviceResult.status === "rejected"
            ? deviceResult.reason?.message || "Device status is unavailable."
            : "",
      };
      if (requestId !== statusRequestId.current) return currentStatus;

      if (healthResult.status === "fulfilled") {
        setBackendOnline(true);
        setBackendError("");
      } else {
        setBackendOnline(false);
        setBackendError(healthResult.reason?.message || "Backend is unavailable.");
      }

      if (!isAuthenticated) {
        setDeviceStatus(null);
        setDeviceError("");
      } else if (deviceResult.status === "fulfilled") {
        setDeviceStatus(deviceResult.value);
        setDeviceError("");
      } else {
        setDeviceStatus(null);
        setDeviceError(deviceResult.reason?.message || "Device status is unavailable.");
        if (deviceResult.reason?.status === 401) {
          setDashboardAuthenticated(false);
          setRememberSession(false);
          setAccessCodeInput("");
          setAuthNotice("Your dashboard session expired or is no longer valid. Sign in again.");
          setDeviceStatus(null);
          setDeviceError("");
        }
      }

      setStatusBusy(false);
      return currentStatus;
    },
    [dashboardAuthenticated],
  );

  useEffect(() => {
    if (!authInitialized) return undefined;
    let timerId;
    let cancelled = false;

    const poll = async () => {
      await refreshBackendStatus();
      if (!cancelled) {
        timerId = window.setTimeout(poll, STATUS_POLL_INTERVAL_MS);
      }
    };

    void poll();
    return () => {
      cancelled = true;
      window.clearTimeout(timerId);
    };
  }, [authInitialized, refreshBackendStatus]);

  const refreshLocalStatus = useCallback(async () => {
    try {
      const status = await getStatus();
      setWifiStatus(status);
      setWifiError("");
      setWifiStatusLoaded(true);
      if (status.reachableAddress) setDeviceAddress(status.reachableAddress);
      return status;
    } catch (error) {
      setWifiError(error.message || "Unable to retrieve ESP32 status.");
      setWifiStatusLoaded(true);
      return null;
    }
  }, []);

  const handleLogin = async (event) => {
    event.preventDefault();
    const candidate = accessCodeInput.trim();
    if (!candidate) {
      setAuthError("Enter the dashboard access code.");
      return;
    }

    setAuthBusy(true);
    setAuthError("");
    setAuthNotice("");
    try {
    await createDashboardSession(candidate, rememberSession);
    setDashboardAuthenticated(true);
    setAuthInitializationError("");
    setAccessCodeInput("");
    setDeviceStatus(null);
    setDeviceError("");
    setPage("dashboard");
    } catch (error) {
      setAuthError(error.message || "Dashboard authentication failed.");
    } finally {
      setAuthBusy(false);
    }
  };

  const handleLogout = async () => {
    setAuthError("");
    try {
      await logoutDashboardSession();
      setDashboardAuthenticated(false);
      setRememberSession(false);
      setAuthNotice("");
      setDeviceStatus(null);
      setDeviceError("");
    } catch (error) {
      setAuthNotice(
        error?.message
          ? `Could not revoke the dashboard session: ${error.message}`
          : "Could not revoke the dashboard session. You remain signed in; try signing out again.",
      );
    }
  };

  const handleSendNotice = async (notice) => {
    const currentStatus = await refreshBackendStatus();
    if (!currentStatus?.backendOnline) {
      throw new Error("The backend is offline. Try again when it is available.");
    }
    if (!currentStatus.deviceStatus?.connected) {
      throw new Error(currentStatus.deviceError
        ? `Cannot verify ESP32 status: ${currentStatus.deviceError}`
        : "The ESP32 is disconnected. Reconnect it before sending a notice.");
    }
    const result = await sendNotice(notice);
    await refreshBackendStatus();
    return result;
  };

  const handleConnect = async (ssid, password) => {
    setConnectionFeedback(null);
    const result = await connectWiFi(ssid, password);
    void refreshLocalStatus();
    return result;
  };

  const handleReconnect = async () => {
    setConnectionFeedback(null);
    const result = await reconnectWiFi();
    void refreshLocalStatus();
    return result;
  };

  const handleDisconnect = async () => {
    const result = await disconnectWiFi();
    setConnectionFeedback(null);
    let reconnectAddress = "";
    if (wifiStatus.apIp) {
      reconnectAddress = setESP32Address(wifiStatus.apIp);
      setDeviceAddress(reconnectAddress);
    }
    void refreshLocalStatus();
    return { ...result, reconnectAddress };
  };

  const handleSaveDeviceAddress = async (value) => {
    const savedAddress = setESP32Address(value);
    setDeviceAddress(savedAddress);
    const status = await refreshLocalStatus();
    if (!status) {
      throw new Error(
        `Address saved as ${savedAddress}, but the ESP32 could not be reached.`,
      );
    }
    return { message: `ESP32 address saved as ${savedAddress}.`, address: savedAddress };
  };

  const handleNavigate = (nextPage) => {
    setPage(nextPage);
    if (nextPage === "setup" && LOCAL_SETUP_AVAILABLE) {
      void refreshLocalStatus();
    }
  };

  const localWifiProps = {
    wifiStatus,
    statusError: wifiError,
    statusLoaded: wifiStatusLoaded,
    connectionFeedback,
    deviceAddress,
    onSaveDeviceAddress: handleSaveDeviceAddress,
    onDiscoverDevice: refreshLocalStatus,
    onConnect: handleConnect,
    onDisconnect: handleDisconnect,
    onReconnect: handleReconnect,
  };

  const deviceConnected = deviceStatus?.connected === true;
  const deviceNeedsLogin = !dashboardAuthenticated;

  return (
    <div className="dashboard">
      <Header
        backendOnline={backendOnline}
        deviceConnected={deviceConnected}
        deviceStatusKnown={deviceStatus !== null && !deviceError}
      />
      <main className="main-content">
        <div className="main-toolbar">
          <Navbar
            activePage={page}
            showSetup={LOCAL_SETUP_AVAILABLE}
            showRemoteWifi={dashboardAuthenticated}
            onNavigate={handleNavigate}
          />
          {dashboardAuthenticated && (
            <button className="text-button logout-button" onClick={handleLogout} type="button">
              Sign out
            </button>
          )}
        </div>

        <section className="status-overview" aria-label="System status">
          <div className="status-overview-heading">
            <div>
              <p className="eyebrow">SYSTEM OVERVIEW</p>
              <h2>Device status</h2>
            </div>
            <button
              className="outline-button refresh-button"
              disabled={statusBusy}
              onClick={() => void refreshBackendStatus()}
              type="button"
            >
              {statusBusy ? "Refreshing…" : "Refresh status"}
            </button>
          </div>
          <div className="status-grid">
            <StatusTile
              label="Backend"
              state={backendOnline === null ? "checking" : backendOnline ? "online" : "offline"}
              detail={backendError}
            />
            <StatusTile
              label="ESP32"
              state={deviceNeedsLogin ? "locked" : deviceError ? "unknown" : deviceConnected ? "online" : "offline"}
              detail={
                deviceNeedsLogin
                  ? "Sign in to check device status"
                  : deviceError || (deviceConnected ? "Connected to the backend" : "Not connected to the backend")
              }
            />
            <StatusTile
              label="WebSocket"
              state={
                deviceNeedsLogin
                  ? "locked"
                  : deviceStatus?.websocketConnected === true
                    ? "online"
                    : deviceStatus?.websocketConnected === false
                      ? "offline"
                      : "unknown"
              }
              detail={deviceNeedsLogin ? "Sign in to check connection" : "Device-to-backend channel"}
            />
            <StatusTile
              label="Last device communication"
              state="neutral"
              detail={
                deviceNeedsLogin
                  ? "Sign in to view"
                  : formatLastCommunication(deviceStatus?.lastSeenAt)
              }
            />
          </div>
        </section>

        {authNotice && (
          <p className="feedback error" role="status">{authNotice}</p>
        )}

        {page === "setup" && LOCAL_SETUP_AVAILABLE ? (
          <WiFiSettings {...localWifiProps} />
        ) : !authInitialized ? (
          <section className="card access-card" role="status">
            Checking dashboard session…
          </section>
        ) : authInitializationError ? (
          <section className="card access-card" aria-labelledby="session-error-title">
            <h3 id="session-error-title">Unable to verify dashboard session</h3>
            <p className="feedback error" role="alert">{authInitializationError}</p>
            <button
              className="secondary-button"
              onClick={() => {
                setAuthInitialized(false);
                setAuthInitializationError("");
                void initializeAuthentication();
              }}
              type="button"
            >
              Retry session check
            </button>
          </section>
        ) : page === "wifi" && dashboardAuthenticated ? (
          <RemoteWiFiConfiguration
            deviceConnected={deviceConnected}
            onConfigured={refreshBackendStatus}
            wifiStatus={deviceStatus?.wifi}
          />
        ) : !dashboardAuthenticated ? (
          <section className="card access-card" aria-labelledby="access-title">
            <div className="card-heading">
              <div>
                <p className="eyebrow">DASHBOARD ACCESS</p>
                <h3 id="access-title">Sign in to manage your board</h3>
              </div>
            </div>
            <p className="access-description">
              Enter the access code configured on the backend. It is checked by the backend and is not included in the deployed JavaScript bundle.
            </p>
            <form onSubmit={handleLogin}>
              <label htmlFor="dashboard-access-code">Dashboard access code</label>
              <div style={{ position: "relative", width: "100%" }}>
                <input
                  autoComplete="off"
                  id="dashboard-access-code"
                  onChange={(event) => setAccessCodeInput(event.target.value)}
                  type={showAccessCode ? "text" : "password"}
                  value={accessCodeInput}
                  style={{ paddingRight: "48px", width: "100%" }}
                />
                <button
                  type="button"
                  onClick={() => setShowAccessCode((visible) => !visible)}
                  aria-label={showAccessCode ? "Hide access code" : "Show access code"}
                  aria-pressed={showAccessCode}
                  title={showAccessCode ? "Hide access code" : "Show access code"}
                  style={{
                    position: "absolute",
                    right: "10px",
                    top: "50%",
                    transform: "translateY(-50%)",
                    border: "none",
                    background: "transparent",
                    padding: "6px",
                    cursor: "pointer",
                    display: "flex",
                    alignItems: "center",
                    color: "inherit",
                  }}
                >
                  {showAccessCode ? (
                    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d="M3 3l18 18" />
                      <path d="M10.6 10.6a2 2 0 002.8 2.8" />
                      <path d="M9.9 5.2A10.8 10.8 0 0112 5c5 0 9 5 9 7a9.8 9.8 0 01-2.1 3.1" />
                      <path d="M6.2 6.2C3.9 7.7 3 10.2 3 12c0 2 4 7 9 7a9.8 9.8 0 004.1-.9" />
                    </svg>
                  ) : (
                    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z" />
                      <circle cx="12" cy="12" r="3" />
                    </svg>
                  )}
                </button>
              </div>
              <label className="remember-token-option">
                <input
                  checked={rememberSession}
                  onChange={(event) => setRememberSession(event.target.checked)}
                  type="checkbox"
                />
                Remember me on this device
              </label>
              <p className="remember-token-warning">
                Keeps the secure, HttpOnly session cookie for 30 days instead of 12 hours. Don’t use on a shared device.
              </p>
              <button className="primary-button" disabled={authBusy} type="submit">
                {authBusy ? "Checking access…" : "Sign in"}
              </button>
            </form>
            {authError && <p className="feedback error" role="alert">{authError}</p>}
          </section>
        ) : (
          <SendNotice
            backendOnline={backendOnline}
            deviceError={deviceError}
            deviceStatus={deviceStatus}
            latestNotice={deviceStatus?.latestNotice}
            onSendNotice={handleSendNotice}
          />
        )}

        {LOCAL_SETUP_AVAILABLE && page === "setup" && (
          <p className="network-note">
            Local provisioning requires this device to reach the ESP32 setup access point or its Wi-Fi network. The browser cannot switch networks automatically.
          </p>
        )}
      </main>
      <Footer />
    </div>
  );
}

function StatusTile({ label, state, detail }) {
  const stateLabel = {
    online: "Online",
    offline: "Offline",
    checking: "Checking",
    locked: "Sign-in required",
    unknown: "Unknown",
    neutral: "",
  }[state];

  return (
    <div className={`status-tile status-tile-${state}`}>
      <span className="status-tile-label">{label}</span>
      {stateLabel && <strong>{stateLabel}</strong>}
      <span className="status-tile-detail">{detail}</span>
    </div>
  );
}

export default App;
