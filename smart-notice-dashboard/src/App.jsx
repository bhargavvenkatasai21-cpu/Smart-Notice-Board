import { useCallback, useEffect, useRef, useState } from "react";
import Header from "./components/Header.jsx";
import Footer from "./components/Footer.jsx";
import Navbar from "./components/Navbar.jsx";
import SendNotice from "./pages/SendNotice.jsx";
import WiFiSettings from "./pages/WiFiSettings.jsx";
import {
  connectWiFi,
  disconnectWiFi,
  getESP32Address,
  getStatus,
  reconnectWiFi,
  setESP32Address,
} from "./services/esp32Service.js";
import "./styles/App.css";

const INITIAL_STATUS = {
  connected: false,
  connecting: false,
  ip: "",
  ssid: "",
  apIp: "",
  savedCredentials: false,
  connectionError: "",
};

const CONNECTION_CONFIRMATION_TIMEOUT_MS = 35000;
const STATUS_POLL_INTERVAL_MS = 5000;

function App() {
  const [page, setPage] = useState("wifi");
  const [wifiStatus, setWifiStatus] = useState(INITIAL_STATUS);
  const [statusError, setStatusError] = useState("");
  const [statusLoaded, setStatusLoaded] = useState(false);
  const [connectionFeedback, setConnectionFeedback] = useState(null);
  const [deviceAddress, setDeviceAddress] = useState(getESP32Address);
  const connectionRequested = useRef(false);
  const connectionDeadline = useRef(0);
  const statusRequestId = useRef(0);

  const refreshStatus = useCallback(async () => {
    const requestId = ++statusRequestId.current;
    try {
      const status = await getStatus();
      if (requestId !== statusRequestId.current) return status;

      setWifiStatus(status);
      setStatusError("");
      setStatusLoaded(true);
      if (status.reachableAddress) {
        setDeviceAddress(status.reachableAddress);
      }

      if (connectionRequested.current && status.connected) {
        connectionRequested.current = false;
        connectionDeadline.current = 0;
        setConnectionFeedback({
          kind: "success",
          message: `Connected to ${status.ssid || "Wi-Fi"} at ${status.ip}. If this device is still connected to SmartNoticeBoard, switch this device back to the Wi-Fi network${status.ssid ? ` named ${status.ssid}` : ""}; discovery will continue automatically.`,
        });
        setPage("notice");
      } else if (connectionRequested.current && !status.connecting) {
        connectionRequested.current = false;
        connectionDeadline.current = 0;
        setConnectionFeedback({
          kind: "error",
          message:
            status.connectionError ||
            "The ESP32 could not connect. Check the Wi-Fi details and try again.",
        });
      } else if (
        connectionRequested.current &&
        Date.now() >= connectionDeadline.current
      ) {
        connectionRequested.current = false;
        connectionDeadline.current = 0;
        setConnectionFeedback({
          kind: "error",
          message:
            "The ESP32 did not confirm the connection within 35 seconds. Check the router, password, and client-isolation settings, then retry.",
        });
      }

      return status;
    } catch (error) {
      if (requestId !== statusRequestId.current) return null;

      setStatusError(error.message || "Unable to retrieve ESP32 status.");
      setStatusLoaded(true);
      if (
        connectionRequested.current &&
        Date.now() >= connectionDeadline.current
      ) {
        connectionRequested.current = false;
        connectionDeadline.current = 0;
        setConnectionFeedback({
          kind: "error",
          message:
            "The ESP32 did not confirm the connection within 35 seconds. Stay connected to the setup access point and retry, or check the router and client-isolation settings.",
        });
      }
      return null;
    }
  }, []);

  useEffect(() => {
    let timerId;
    let cancelled = false;

    const pollStatus = async () => {
      await refreshStatus();
      if (!cancelled) {
        timerId = window.setTimeout(pollStatus, STATUS_POLL_INTERVAL_MS);
      }
    };

    timerId = window.setTimeout(pollStatus, 0);

    return () => {
      cancelled = true;
      window.clearTimeout(timerId);
    };
  }, [refreshStatus]);

  const handleConnect = async (ssid, password) => {
    setConnectionFeedback(null);
    const result = await connectWiFi(ssid, password);
    connectionRequested.current = true;
    connectionDeadline.current = Date.now() + CONNECTION_CONFIRMATION_TIMEOUT_MS;
    void refreshStatus();
    return result;
  };

  const handleReconnect = async () => {
    setConnectionFeedback(null);
    const result = await reconnectWiFi();
    connectionRequested.current = true;
    connectionDeadline.current = Date.now() + CONNECTION_CONFIRMATION_TIMEOUT_MS;
    void refreshStatus();
    return result;
  };

  const handleDisconnect = async () => {
    const result = await disconnectWiFi();
    connectionRequested.current = false;
    connectionDeadline.current = 0;
    setConnectionFeedback(null);
    setPage("wifi");
    let reconnectAddress = "";
    if (wifiStatus.apIp) {
      reconnectAddress = setESP32Address(wifiStatus.apIp);
      setDeviceAddress(reconnectAddress);
    }
    void refreshStatus();
    return { ...result, reconnectAddress };
  };

  const handleSaveDeviceAddress = async (value) => {
    const savedAddress = setESP32Address(value);
    setDeviceAddress(savedAddress);
    setStatusError("");
    setStatusLoaded(false);

    const status = await refreshStatus();
    if (!status) {
      throw new Error(
        `Address saved as ${savedAddress}, but the ESP32 could not be reached.`,
      );
    }

    return {
      message: `ESP32 address saved as ${savedAddress}.`,
      address: savedAddress,
    };
  };

  const navigate = (nextPage) => {
    if (nextPage === "wifi" || wifiStatus.connected) {
      setPage(nextPage);
    }
  };

  const pageProps = {
    wifiStatus,
    statusError,
    statusLoaded,
    connectionFeedback,
    deviceAddress,
    refreshStatus,
    onSaveDeviceAddress: handleSaveDeviceAddress,
    onDiscoverDevice: refreshStatus,
    onConnect: handleConnect,
    onDisconnect: handleDisconnect,
    onReconnect: handleReconnect,
    onNavigate: navigate,
  };

  return (
    <div className="dashboard">
      <Header
        wifiStatus={wifiStatus}
        statusError={statusError}
        statusLoaded={statusLoaded}
      />
      <main className="main-content">
        <Navbar
          activePage={page}
          isConnected={wifiStatus.connected}
          onNavigate={navigate}
        />
        {page === "wifi" ? (
          <WiFiSettings {...pageProps} />
        ) : (
          <SendNotice {...pageProps} />
        )}
        <p className="network-note">
          The browser must be able to reach the ESP32 over the network. Direct HTTP works on the
          same LAN or another routed/private network. Router client-isolation settings or guest
          networks may require a VPN or secure relay.
        </p>
      </main>
      <Footer />
    </div>
  );
}

export default App;
