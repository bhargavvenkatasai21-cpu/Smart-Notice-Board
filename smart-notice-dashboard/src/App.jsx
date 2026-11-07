import { useCallback, useEffect, useRef, useState } from "react";
import Header from "./components/Header.jsx";
import Footer from "./components/Footer.jsx";
import Navbar from "./components/Navbar.jsx";
import SendNotice from "./pages/SendNotice.jsx";
import WiFiSettings from "./pages/WiFiSettings.jsx";
import {
  connectWiFi,
  disconnectWiFi,
  getDeviceBaseUrl,
  getStatus,
  reconnectWiFi,
  saveDeviceBaseUrl,
} from "./services/esp32Service.js";
import "./styles/App.css";

const INITIAL_STATUS = {
  connected: false,
  connecting: false,
  ip: "",
  ssid: "",
  apIp: "",
  connectionError: "",
};

function App() {
  const [page, setPage] = useState("wifi");
  const [wifiStatus, setWifiStatus] = useState(INITIAL_STATUS);
  const [statusError, setStatusError] = useState("");
  const [statusLoaded, setStatusLoaded] = useState(false);
  const [connectionFeedback, setConnectionFeedback] = useState(null);
  const [deviceAddress, setDeviceAddress] = useState(getDeviceBaseUrl);
  const connectionRequested = useRef(false);
  const statusRequestId = useRef(0);

  const refreshStatus = useCallback(async () => {
    const requestId = ++statusRequestId.current;
    try {
      const status = await getStatus();
      if (requestId !== statusRequestId.current) return status;

      setWifiStatus(status);
      setStatusError("");
      setStatusLoaded(true);

      if (connectionRequested.current && status.connected) {
        connectionRequested.current = false;
        setConnectionFeedback({
          kind: "success",
          message: `Connected to ${status.ssid || "Wi-Fi"} successfully.`,
        });
        setPage("notice");
      } else if (connectionRequested.current && !status.connecting) {
        connectionRequested.current = false;
        setConnectionFeedback({
          kind: "error",
          message:
            status.connectionError ||
            "The ESP32 could not connect. Check the Wi-Fi details and try again.",
        });
      }

      return status;
    } catch (error) {
      if (requestId !== statusRequestId.current) return null;

      setStatusError(error.message || "Unable to retrieve ESP32 status.");
      setStatusLoaded(true);
      return null;
    }
  }, []);

  useEffect(() => {
    const initialRequestId = window.setTimeout(() => {
      void refreshStatus();
    }, 0);
    const intervalId = window.setInterval(() => {
      void refreshStatus();
    }, 4000);

    return () => {
      window.clearTimeout(initialRequestId);
      window.clearInterval(intervalId);
    };
  }, [refreshStatus]);

  const handleConnect = async (ssid, password) => {
    setConnectionFeedback(null);
    const result = await connectWiFi(ssid, password);
    connectionRequested.current = true;
    void refreshStatus();
    return result;
  };

  const handleReconnect = async () => {
    setConnectionFeedback(null);
    const result = await reconnectWiFi();
    connectionRequested.current = true;
    void refreshStatus();
    return result;
  };

  const handleDisconnect = async () => {
    const result = await disconnectWiFi();
    connectionRequested.current = false;
    setConnectionFeedback(null);
    setPage("wifi");
    let reconnectAddress = "";
    if (wifiStatus.apIp) {
      reconnectAddress = saveDeviceBaseUrl(wifiStatus.apIp);
      setDeviceAddress(reconnectAddress);
    }
    void refreshStatus();
    return { ...result, reconnectAddress };
  };

  const handleSaveDeviceAddress = async (value) => {
    const savedAddress = saveDeviceBaseUrl(value);
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
          same LAN or another routed/private network; isolated networks require a VPN or relay.
        </p>
      </main>
      <Footer />
    </div>
  );
}

export default App;
