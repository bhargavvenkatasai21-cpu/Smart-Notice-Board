const DEVICE_URL_STORAGE_KEY = "smart-notice-board-device-url";
const REQUEST_TIMEOUT_MS = 8000;
const DEFAULT_DEVICE_URL =
  import.meta.env?.VITE_ESP32_URL || "http://192.168.4.1";

export function getDeviceBaseUrl() {
  const savedUrl =
    typeof window === "undefined"
      ? ""
      : window.localStorage.getItem(DEVICE_URL_STORAGE_KEY);
  return savedUrl || DEFAULT_DEVICE_URL;
}

export function normalizeDeviceBaseUrl(value) {
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

export function saveDeviceBaseUrl(value) {
  const normalizedUrl = normalizeDeviceBaseUrl(value);
  window.localStorage.setItem(DEVICE_URL_STORAGE_KEY, normalizedUrl);
  return normalizedUrl;
}

async function request(path, options = {}) {
  let response;
  const deviceUrl = getDeviceBaseUrl();
  const parsedDeviceUrl = new URL(deviceUrl);

  if (
    typeof window !== "undefined" &&
    window.location?.protocol === "https:" &&
    parsedDeviceUrl.protocol === "http:"
  ) {
    throw new Error(
      "This dashboard is loaded over HTTPS, so the browser blocks requests to the ESP32 over HTTP. Open the dashboard over HTTP on the same network or use an HTTPS proxy for the ESP32.",
    );
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(
    () => controller.abort(),
    REQUEST_TIMEOUT_MS,
  );

  try {
    response = await fetch(`${deviceUrl}${path}`, {
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
        `Cannot reach the ESP32 at ${deviceUrl}. Check the address and network access.`,
        { cause: error },
      );
    }
    if (error.name === "AbortError") {
      throw new Error(`The ESP32 at ${deviceUrl} did not respond in time.`, {
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
    } catch {
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

export async function getStatus() {
  const status = await request("/status", { method: "GET" });

  if (
    typeof status !== "object" ||
    status === null ||
    typeof status.connected !== "boolean"
  ) {
    throw new Error("The ESP32 returned an invalid Wi-Fi status response.");
  }

  return status;
}

export function connectWiFi(ssid, password) {
  return request("/connect", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ssid, password }),
  });
}

export function disconnectWiFi() {
  return request("/disconnect", { method: "POST" });
}

export function reconnectWiFi() {
  return request("/reconnect", { method: "POST" });
}

export function sendNotice(notice) {
  return request("/notice", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ notice }),
  });
}

export function checkESP32() {
  return request("/", { method: "GET" });
}
