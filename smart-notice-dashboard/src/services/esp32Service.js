const ADDRESS_KEY = "smart-notice-board-address";
const STATION_ADDRESS_KEY = "smart-notice-board-station-address";
const AP_ADDRESS_KEY = "smart-notice-board-ap-address";
const REQUEST_TIMEOUT_MS = 2500;
const BACKEND_REQUEST_TIMEOUT_MS = 15000;
const MAX_NOTICE_LENGTH = 200;
const DEFAULT_BACKEND_URL =
  import.meta.env?.VITE_API_BASE_URL ||
  "https://smart-notice-board-api.onrender.com";
const DEFAULT_AP_ADDRESS =
  import.meta.env?.VITE_ESP32_AP_URL || "http://192.168.4.1";

function sessionStorage() {
  return typeof window === "undefined" ? null : window.sessionStorage;
}

export function normalizeESP32Address(value) {
  const input = value.trim();
  if (!input) {
    throw new Error("Enter the ESP32 IP address or host name.");
  }

  let url;
  try {
    url = new URL(input.includes("://") ? input : `http://${input}`);
  } catch {
    throw new Error("Enter a valid ESP32 IP address or host name.");
  }

  if (
    !["http:", "https:"].includes(url.protocol) ||
    !url.hostname ||
    url.username ||
    url.password ||
    (url.pathname !== "/" && url.pathname !== "")
  ) {
    throw new Error(
      "Use an HTTP(S) address with no credentials or path, such as 192.168.4.1.",
    );
  }

  return url.origin;
}

export function getESP32Address() {
  return (
    sessionStorage()?.getItem(ADDRESS_KEY) ||
    normalizeESP32Address(DEFAULT_AP_ADDRESS)
  );
}

export function setESP32Address(address) {
  const normalizedAddress = normalizeESP32Address(address);
  sessionStorage()?.setItem(ADDRESS_KEY, normalizedAddress);
  return normalizedAddress;
}

function getBackendUrl() {
  try {
    const url = new URL(DEFAULT_BACKEND_URL);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      !url.hostname ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    ) {
      throw new Error("Use an HTTP(S) backend origin without credentials or a path.");
    }
    return url.origin;
  } catch (error) {
    throw new Error("VITE_API_BASE_URL must be a valid HTTP(S) URL.", {
      cause: error,
    });
  }
}

async function requestBackend(path, options = {}) {
  const controller = new AbortController();
  const timeoutId = setTimeout(
    () => controller.abort(),
    BACKEND_REQUEST_TIMEOUT_MS,
  );
  const headers = {
    Accept: "application/json",
    ...options.headers,
  };

  let response;
  try {
    response = await fetch(`${getBackendUrl()}${path}`, {
      ...options,
      headers,
      credentials: "include",
      signal: controller.signal,
      cache: "no-store",
    });
  } catch (error) {
    if (error.name === "AbortError") {
      throw new Error("The backend request timed out. Try again shortly.", {
        cause: error,
      });
    }
    if (error instanceof TypeError) {
      throw new Error(
        "Cannot reach the Smart Notice Board backend. It may be starting up or temporarily unavailable.",
        { cause: error },
      );
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }

  let data;
  try {
    data = await response.json();
  } catch (error) {
    throw new Error("The backend returned an invalid response.", {
      cause: error,
    });
  }

  if (!response.ok) {
    const message =
      typeof data?.message === "string"
        ? data.message
        : `Backend request failed with HTTP ${response.status}.`;
    const error = new Error(message);
    error.status = response.status;
    if (typeof data?.code === "string") error.code = data.code;
    throw error;
  }

  return data;
}

export async function getBackendHealth() {
  const health = await requestBackend("/api/health", { method: "GET" });
  if (health?.status !== "OK") {
    throw new Error("The backend health check returned an unexpected status.");
  }
  return health;
}

export async function createDashboardSession(accessCode, rememberMe = false) {
  if (typeof accessCode !== "string" || !accessCode.trim()) {
    throw new Error("Enter the dashboard access code.");
  }
  const session = await requestBackend("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ accessCode: accessCode.trim(), rememberMe }),
  });
  if (
    session?.success !== true ||
    typeof session.expiresAt !== "string"
  ) {
    throw new Error("The backend did not create a valid dashboard session.");
  }
  return session;
}

export async function getDashboardSession() {
  const session = await requestBackend("/api/auth/session", { method: "GET" });
  if (session?.success !== true || typeof session.expiresAt !== "string") {
    throw new Error("The backend did not return a valid dashboard session.");
  }
  return session;
}

export async function logoutDashboardSession() {
  const result = await requestBackend("/api/auth/logout", { method: "POST" });
  if (result?.success !== true) {
    throw new Error("The backend did not confirm the dashboard sign-out.");
  }
  return result;
}

export async function getDeviceStatus() {
  const status = await requestBackend("/api/device/status", {
    method: "GET",
  });
  if (typeof status?.connected !== "boolean") {
    throw new Error("The backend returned an invalid device status response.");
  }
  return status;
}

function utf8ByteLength(value) {
  return new TextEncoder().encode(value).length;
}

function validateRemoteWifiConfiguration(ssid, password) {
  if (typeof ssid !== "string" || !ssid.trim()) {
    throw new Error("Enter a Wi-Fi network name.");
  }
  if (utf8ByteLength(ssid.trim()) > 32) {
    throw new Error("Wi-Fi network names can be at most 32 UTF-8 bytes.");
  }
  if (
    typeof password !== "string" ||
    (password.length > 0 &&
      (utf8ByteLength(password) < 8 || utf8ByteLength(password) > 63))
  ) {
    throw new Error(
      "Use a Wi-Fi password between 8 and 63 UTF-8 bytes, or leave it empty for an open network.",
    );
  }
}

export async function startRemoteWifiConfiguration(ssid, password) {
  validateRemoteWifiConfiguration(ssid, password);

  const result = await requestBackend("/api/device/wifi-config", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ssid: ssid.trim(), password }),
  });
  if (
    result?.success !== true ||
    typeof result.requestId !== "string" ||
    result.state !== "command_sent"
  ) {
    throw new Error(
      result?.message || "The backend did not accept the Wi-Fi configuration.",
    );
  }
  return result;
}

export async function getRemoteWifiConfiguration(requestId) {
  if (typeof requestId !== "string" || !requestId.trim()) {
    throw new Error("A Wi-Fi configuration request ID is required.");
  }

  const result = await requestBackend(
    `/api/device/wifi-config/${encodeURIComponent(requestId)}`,
    { method: "GET" },
  );
  const operation = result?.operation;
  if (
    result?.success !== true ||
    operation?.requestId !== requestId ||
    ![
      "command_sent",
      "accepted",
      "connecting",
      "wifi_connected",
      "authenticated",
      "failed",
      "timed_out",
    ].includes(operation.state)
  ) {
    throw new Error("The backend returned an invalid Wi-Fi operation status.");
  }
  return operation;
}

export async function startRemoteWifiForget() {
  const result = await requestBackend("/api/device/wifi-forget", {
    method: "POST",
  });
  if (
    result?.success !== true ||
    typeof result.requestId !== "string" ||
    result.state !== "command_sent"
  ) {
    throw new Error(
      result?.message || "The backend did not accept the Wi-Fi deletion request.",
    );
  }
  return result;
}

export async function getRemoteWifiForget(requestId) {
  if (typeof requestId !== "string" || !requestId.trim()) {
    throw new Error("A Wi-Fi deletion request ID is required.");
  }

  const result = await requestBackend(
    `/api/device/wifi-forget/${encodeURIComponent(requestId)}`,
    { method: "GET" },
  );
  const operation = result?.operation;
  if (
    result?.success !== true ||
    operation?.requestId !== requestId ||
    !["command_sent", "accepted", "deleted", "failed", "timed_out"].includes(
      operation.state,
    )
  ) {
    throw new Error("The backend returned an invalid Wi-Fi deletion status.");
  }
  return operation;
}

export async function startFirmwareUpdate(allowReinstall = false) {
  const result = await requestBackend("/api/device/firmware-update", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ allowReinstall }),
  });
  if (
    result?.success !== true ||
    typeof result.requestId !== "string" ||
    result.state !== "command_sent"
  ) {
    throw new Error(
      result?.message || "The backend did not accept the firmware update request.",
    );
  }
  return result;
}

export async function startFirmwareCheck() {
  const result = await requestBackend("/api/device/firmware-check", {
    method: "POST",
  });
  if (
    result?.success !== true ||
    typeof result.requestId !== "string" ||
    result.state !== "command_sent"
  ) {
    throw new Error(
      result?.message || "The backend did not accept the firmware check request.",
    );
  }
  return result;
}

export async function getFirmwareUpdate(requestId) {
  if (typeof requestId !== "string" || !requestId.trim()) {
    throw new Error("A firmware update request ID is required.");
  }

  const result = await requestBackend(
    `/api/device/firmware-update/${encodeURIComponent(requestId)}`,
    { method: "GET" },
  );
  const operation = result?.operation;
  if (
    result?.success !== true ||
    operation?.requestId !== requestId ||
    ![
      "command_sent",
      "checking",
      "available",
      "downloading",
      "verifying",
      "rebooting",
      "verified",
      "up_to_date",
      "failed",
      "timed_out",
    ].includes(operation.state)
  ) {
    throw new Error("The backend returned an invalid firmware update status.");
  }
  return operation;
}

function assertLocalSetupEnvironment() {
  if (
    !import.meta.env?.DEV ||
    (typeof window !== "undefined" &&
      window.location?.protocol !== "http:")
  ) {
    throw new Error(
      "Wi-Fi provisioning is available only from the local HTTP development dashboard. Open it on a device that can reach the ESP32 setup access point.",
    );
  }
}

function getStationAddress() {
  return sessionStorage()?.getItem(STATION_ADDRESS_KEY) || "";
}

function getAccessPointAddress() {
  return (
    sessionStorage()?.getItem(AP_ADDRESS_KEY) ||
    normalizeESP32Address(DEFAULT_AP_ADDRESS)
  );
}

function ensureBrowserCanReach(address) {
  const target = new URL(address);
  if (
    typeof window !== "undefined" &&
    window.location?.protocol === "https:" &&
    target.protocol === "http:"
  ) {
    throw new Error(
      "This dashboard is loaded over HTTPS, so the browser blocks requests to the ESP32 over HTTP. Open the dashboard at http://localhost:5173 on a network that can reach the board, or use an HTTPS reverse proxy or secure relay.",
    );
  }
}

async function requestAt(address, path, options = {}) {
  ensureBrowserCanReach(address);
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let response;

  try {
    response = await fetch(`${address}${path}`, {
      ...options,
      signal: controller.signal,
      headers: {
        Accept: "application/json",
        ...options.headers,
      },
      cache: "no-store",
    });
  } catch (error) {
    if (error instanceof TypeError) {
      throw new Error(
        `Cannot reach the ESP32 at ${address}. Check the connected Wi-Fi network and device address.`,
        { cause: error },
      );
    }
    if (error.name === "AbortError") {
      throw new Error(`The ESP32 at ${address} did not respond within 2.5 seconds.`, {
        cause: error,
      });
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }

  const responseText = await response.text();
  let data = null;
  if (responseText) {
    try {
      data = JSON.parse(responseText);
    } catch (error) {
      if (response.headers.get("content-type")?.includes("application/json")) {
        throw new Error("The ESP32 returned invalid JSON.", { cause: error });
      }
      data = responseText;
    }
  }

  if (!response.ok) {
    const message =
      typeof data === "object" && data !== null && "message" in data
        ? data.message
        : typeof data === "string" && data
          ? data
          : `ESP32 request failed with HTTP ${response.status}.`;
    throw new Error(message);
  }

  return data;
}

function validateStatus(status) {
  if (
    typeof status !== "object" ||
    status === null ||
    typeof status.connected !== "boolean" ||
    typeof status.connecting !== "boolean"
  ) {
    throw new Error("The ESP32 returned an invalid Wi-Fi status response.");
  }
  return status;
}

function discoveryCandidates() {
  const candidates = [
    getESP32Address(),
    getAccessPointAddress(),
    getStationAddress(),
  ].filter(Boolean);
  return [...new Set(candidates)];
}

export async function discoverESP32() {
  assertLocalSetupEnvironment();
  const failures = [];

  for (const address of discoveryCandidates()) {
    try {
      const status = validateStatus(
        await requestAt(address, "/status", { method: "GET" }),
      );
      const storage = sessionStorage();
      const isAccessPointAddress =
        address === getAccessPointAddress() ||
        address === normalizeESP32Address(DEFAULT_AP_ADDRESS);
      const accessPointAddress = status.apIp
        ? normalizeESP32Address(status.apIp)
        : "";

      if (accessPointAddress) {
        storage?.setItem(AP_ADDRESS_KEY, accessPointAddress);
      }

      if (status.connected && status.ip) {
        const stationAddress = normalizeESP32Address(status.ip);
        storage?.setItem(STATION_ADDRESS_KEY, stationAddress);
        if (!isAccessPointAddress) {
          setESP32Address(stationAddress);
        }
      }

      return { ...status, reachableAddress: address };
    } catch (error) {
      failures.push(error.message);
    }
  }

  if (failures.length === 1) {
    throw new Error(failures[0]);
  }

  throw new Error(
    `Could not discover the ESP32 at the setup access point or its last reported Wi-Fi address. Connect to the SmartNoticeBoard access point (192.168.4.1) or return to the same Wi-Fi network as the ESP32. ${failures.at(-1) || ""}`.trim(),
  );
}

export async function getStatus() {
  return discoverESP32();
}

export async function connectWiFi(ssid, password) {
  if (typeof ssid !== "string" || !ssid.trim()) {
    throw new Error("Enter a Wi-Fi network name.");
  }
  if (ssid.length > 32) {
    throw new Error("Wi-Fi network names can be at most 32 characters.");
  }
  if (
    typeof password !== "string" ||
    (password.length > 0 && (password.length < 8 || password.length > 63))
  ) {
    throw new Error(
      "Use a Wi-Fi password between 8 and 63 characters, or leave it empty for an open network.",
    );
  }

  const discovery = await discoverESP32();
  return requestAt(discovery.reachableAddress, "/connect", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ssid, password }),
  });
}

export async function disconnectWiFi() {
  const discovery = await discoverESP32();
  return requestAt(discovery.reachableAddress, "/disconnect", { method: "POST" });
}

export async function reconnectWiFi() {
  const discovery = await discoverESP32();
  return requestAt(discovery.reachableAddress, "/reconnect", { method: "POST" });
}

export async function sendNotice(notice) {
  if (typeof notice !== "string" || !notice.trim()) {
    throw new Error("Enter a notice before sending.");
  }
  if (notice.length > MAX_NOTICE_LENGTH) {
    throw new Error("Notices cannot exceed 200 characters.");
  }
  const result = await requestBackend("/api/notices", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ notice: notice.trim() }),
  });
  if (result?.success !== true || result?.delivered !== true) {
    throw new Error(
      result?.message || "The backend did not confirm delivery to the ESP32.",
    );
  }
  return result;
}

export async function checkESP32() {
  const discovery = await discoverESP32();
  return requestAt(discovery.reachableAddress, "/", { method: "GET" });
}
