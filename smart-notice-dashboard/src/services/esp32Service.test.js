import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  connectWiFi,
  createDashboardSession,
  discoverESP32,
  disconnectWiFi,
  getFirmwareUpdate,
  getBackendHealth,
  getDashboardSession,
  getDeviceStatus,
  getESP32Address,
  getRemoteWifiConfiguration,
  getRemoteWifiForget,
  getStatus,
  logoutDashboardSession,
  normalizeESP32Address,
  reconnectWiFi,
  sendNotice,
  setESP32Address,
  startFirmwareUpdate,
  startRemoteWifiConfiguration,
  startRemoteWifiForget,
} from "./esp32Service.js";

const ACCESS_POINT = "http://192.168.4.1";
const BACKEND =
  import.meta.env?.VITE_API_BASE_URL ||
  "https://smart-notice-board-api.onrender.com";

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function statusResponse(overrides = {}) {
  return {
    connected: false,
    connecting: false,
    ssid: "",
    ip: "",
    apIp: "192.168.4.1",
    savedCredentials: false,
    connectionError: "",
    ...overrides,
  };
}

function mockStatusThen(status, base = ACCESS_POINT) {
  globalThis.fetch = vi.fn(async (url) => {
    if (url === `${base}/status`) {
      return jsonResponse(status);
    }
    return jsonResponse({ message: "ok" }, 202);
  });
}

beforeEach(() => {
  window.sessionStorage.clear();
  vi.stubGlobal("fetch", vi.fn());
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("ESP32 address discovery", () => {
  it("discovers the ESP32 through the provisioning access point", async () => {
    mockStatusThen(statusResponse());

    const status = await discoverESP32();

    expect(status.reachableAddress).toBe(ACCESS_POINT);
    expect(status.apIp).toBe("192.168.4.1");
    expect(fetch).toHaveBeenCalledWith(
      `${ACCESS_POINT}/status`,
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("records the current DHCP address returned by the ESP32", async () => {
    mockStatusThen(
      statusResponse({
        connected: true,
        ssid: "Office WiFi",
        ip: "192.168.1.105",
        savedCredentials: true,
      }),
    );

    const status = await getStatus();
    expect(status.ip).toBe("192.168.1.105");
    expect(status.ssid).toBe("Office WiFi");
  });

  it("replaces a stale station address after the AP reports a new DHCP IP", async () => {
    setESP32Address("192.168.1.50");
    globalThis.fetch = vi.fn(async (url) => {
      if (url === "http://192.168.1.50/status") {
        throw new TypeError("network unavailable");
      }
      if (url === `${ACCESS_POINT}/status`) {
        return jsonResponse(
          statusResponse({
            connected: true,
            ssid: "Office WiFi",
            ip: "192.168.1.106",
          }),
        );
      }
      return jsonResponse({ message: "ok" });
    });

    const status = await discoverESP32();
    expect(status.reachableAddress).toBe(ACCESS_POINT);
    expect(status.ip).toBe("192.168.1.106");
    expect(getESP32Address()).toBe("http://192.168.1.50");

    globalThis.fetch.mockImplementation(async (url) => {
      if (url === `${ACCESS_POINT}/status`) {
        throw new TypeError("AP is no longer reachable");
      }
      if (url === "http://192.168.1.50/status") {
        throw new TypeError("stale address is not reachable");
      }
      if (url === "http://192.168.1.106/status") {
        return jsonResponse(
          statusResponse({
            connected: true,
            ssid: "Office WiFi",
            ip: "192.168.1.106",
          }),
        );
      }
      return jsonResponse({ message: "sent" });
    });

    const stationStatus = await discoverESP32();
    expect(stationStatus.reachableAddress).toBe("http://192.168.1.106");
    expect(getESP32Address()).toBe("http://192.168.1.106");
    expect(fetch.mock.calls.map(([url]) => url)).not.toContain(
      "http://192.168.1.50/notice",
    );
  });

  it("normalizes and validates a manually configured address", () => {
    expect(normalizeESP32Address("192.168.4.1")).toBe(ACCESS_POINT);
    expect(normalizeESP32Address("https://notice-board.local:8443/")).toBe(
      "https://notice-board.local:8443",
    );
    expect(() => normalizeESP32Address("")).toThrow(/Enter the ESP32/);
    expect(() => normalizeESP32Address("ftp://device.local")).toThrow(/HTTP/);
    expect(() =>
      normalizeESP32Address("http://device.local/api"),
    ).toThrow(/no credentials or path/);
  });
});

describe("Wi-Fi actions", () => {
  it("submits valid Wi-Fi credentials to the discovered ESP32", async () => {
    const requests = [];
    globalThis.fetch = vi.fn(async (url, options) => {
      requests.push({ url, options });
      if (url.endsWith("/status")) {
        return jsonResponse(statusResponse());
      }
      return jsonResponse({ message: "credentials saved" }, 202);
    });

    const response = await connectWiFi("Office WiFi", "password123");

    expect(response.message).toBe("credentials saved");
    expect(requests[1].url).toBe(`${ACCESS_POINT}/connect`);
    expect(JSON.parse(requests[1].options.body)).toEqual({
      ssid: "Office WiFi",
      password: "password123",
    });
  });

  it("rejects empty SSIDs and invalid passwords without making a request", async () => {
    await expect(connectWiFi("  ", "password123")).rejects.toThrow(
      /network name/,
    );
    await expect(connectWiFi("Office", "short")).rejects.toThrow(
      /between 8 and 63/,
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it("reports a failed Wi-Fi connection request", async () => {
    mockStatusThen(statusResponse());
    globalThis.fetch.mockImplementation(async (url) =>
      url.endsWith("/status")
        ? jsonResponse(statusResponse())
        : jsonResponse({ message: "A WiFi connection attempt is already in progress" }, 409),
    );

    await expect(connectWiFi("Office", "password123")).rejects.toThrow(
      /already in progress/,
    );
  });

  it("disconnects without clearing the discovered device address", async () => {
    setESP32Address(ACCESS_POINT);
    globalThis.fetch = vi.fn(async (url) =>
      url.endsWith("/status")
        ? jsonResponse(statusResponse({ savedCredentials: true }))
        : jsonResponse({ message: "disconnecting" }, 202),
    );

    const response = await disconnectWiFi();
    expect(response.message).toBe("disconnecting");
    expect(getESP32Address()).toBe(ACCESS_POINT);
    expect((await discoverESP32()).savedCredentials).toBe(true);
  });

  it("reconnects using credentials already saved on the ESP32", async () => {
    globalThis.fetch = vi.fn(async (url) =>
      url.endsWith("/status")
        ? jsonResponse(statusResponse({ savedCredentials: true }))
        : jsonResponse({ message: "reconnecting" }, 202),
    );

    await expect(reconnectWiFi()).resolves.toMatchObject({
      message: "reconnecting",
    });
    expect(fetch.mock.calls.some(([url]) => url.endsWith("/reconnect"))).toBe(
      true,
    );
  });

  it("reports reconnect HTTP failures", async () => {
    globalThis.fetch = vi.fn(async (url) =>
      url.endsWith("/status")
        ? jsonResponse(statusResponse())
        : jsonResponse({ message: "No saved WiFi network exists" }, 400),
    );

    await expect(reconnectWiFi()).rejects.toThrow(/No saved WiFi network/);
  });

  it("times out a request and aborts its fetch", async () => {
    vi.useFakeTimers();
    let requestSignal;
    globalThis.fetch = vi.fn(
      (_url, options) =>
        new Promise((resolve, reject) => {
          requestSignal = options.signal;
          options.signal.addEventListener("abort", () => {
            reject(new DOMException("Aborted", "AbortError"));
          });
        }),
    );

    const pending = getStatus();
    const rejection = expect(pending).rejects.toThrow(
      /did not respond within 2.5 seconds/,
    );
    await vi.advanceTimersByTimeAsync(2500);
    await rejection;
    expect(requestSignal.aborted).toBe(true);
  });
});

describe("status and notice API", () => {
  it("starts a remote Wi-Fi configuration using the authenticated backend", async () => {
    const response = {
      success: true,
      requestId: "request-123",
      state: "command_sent",
    };
    globalThis.fetch = vi.fn(async () => jsonResponse(response, 202));

    await expect(
      startRemoteWifiConfiguration(" Office WiFi ", "password123"),
    ).resolves.toEqual(response);

    expect(fetch).toHaveBeenCalledWith(
      `${BACKEND}/api/device/wifi-config`,
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "Content-Type": "application/json",
        }),
        credentials: "include",
        body: JSON.stringify({ ssid: "Office WiFi", password: "password123" }),
      }),
    );
    expect(window.localStorage.length).toBe(0);
    expect(window.sessionStorage.length).toBe(0);
  });

  it("validates remote network credentials before sending them", async () => {
    await expect(
      startRemoteWifiConfiguration("  ", "password123"),
    ).rejects.toThrow(/network name/);
    await expect(
      startRemoteWifiConfiguration("Office", "short"),
    ).rejects.toThrow(/between 8 and 63 UTF-8 bytes/);
    await expect(
      startRemoteWifiConfiguration("☃".repeat(11), "password123"),
    ).rejects.toThrow(/32 UTF-8 bytes/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("polls a remote Wi-Fi operation using the authenticated backend", async () => {
    const response = {
      success: true,
      operation: {
        requestId: "request-123",
        state: "connecting",
        message: "ESP32 is connecting",
      },
    };
    globalThis.fetch = vi.fn(async () => jsonResponse(response));

    await expect(
      getRemoteWifiConfiguration("request-123"),
    ).resolves.toEqual(response.operation);
    expect(fetch).toHaveBeenCalledWith(
      `${BACKEND}/api/device/wifi-config/request-123`,
      expect.objectContaining({
        method: "GET",
        credentials: "include",
      }),
    );
  });

  it("rejects malformed remote Wi-Fi operation status responses", async () => {
    globalThis.fetch = vi.fn(async () =>
      jsonResponse({
        success: true,
        operation: { requestId: "wrong-request", state: "connecting" },
      }),
    );

    await expect(
      getRemoteWifiConfiguration("request-123"),
    ).rejects.toThrow(/invalid Wi-Fi operation status/);
  });

  it("starts credential deletion without sending a password", async () => {
    const response = {
      success: true,
      requestId: "forget-123",
      state: "command_sent",
    };
    globalThis.fetch = vi.fn(async () => jsonResponse(response, 202));

    await expect(startRemoteWifiForget()).resolves.toEqual(response);
    expect(fetch).toHaveBeenCalledWith(
      `${BACKEND}/api/device/wifi-forget`,
      expect.objectContaining({
        method: "POST",
        credentials: "include",
      }),
    );
    expect(window.localStorage.length).toBe(0);
    expect(window.sessionStorage.length).toBe(0);
  });

  it("polls a Wi-Fi credential deletion operation", async () => {
    const response = {
      success: true,
      operation: {
        requestId: "forget-123",
        state: "deleted",
        message: "Credentials deleted",
      },
    };
    globalThis.fetch = vi.fn(async () => jsonResponse(response));

    await expect(
      getRemoteWifiForget("forget-123"),
    ).resolves.toEqual(response.operation);
    expect(fetch).toHaveBeenCalledWith(
      `${BACKEND}/api/device/wifi-forget/forget-123`,
      expect.objectContaining({
        method: "GET",
        credentials: "include",
      }),
    );
  });

  it("starts a firmware update request through the authenticated backend", async () => {
    const response = {
      success: true,
      requestId: "firmware-123",
      state: "command_sent",
    };
    globalThis.fetch = vi.fn(async () => jsonResponse(response, 202));

    await expect(startFirmwareUpdate()).resolves.toEqual(response);
    expect(fetch).toHaveBeenCalledWith(
      `${BACKEND}/api/device/firmware-update`,
      expect.objectContaining({
        method: "POST",
        credentials: "include",
        body: JSON.stringify({ allowReinstall: false }),
      }),
    );
  });

  it("polls a firmware update and validates the operation state", async () => {
    const response = {
      success: true,
      operation: {
        requestId: "firmware-123",
        state: "verified",
        version: "1.0.1",
      },
    };
    globalThis.fetch = vi.fn(async () => jsonResponse(response));

    await expect(
      getFirmwareUpdate("firmware-123"),
    ).resolves.toEqual(response.operation);
    expect(fetch).toHaveBeenCalledWith(
      `${BACKEND}/api/device/firmware-update/firmware-123`,
      expect.objectContaining({
        method: "GET",
        credentials: "include",
      }),
    );

    globalThis.fetch = vi.fn(async () =>
      jsonResponse({
        success: true,
        operation: { requestId: "firmware-123", state: "untrusted" },
      }),
    );
    await expect(
      getFirmwareUpdate("firmware-123"),
    ).rejects.toThrow(/invalid firmware update status/);
  });

  it("exchanges the access code for a backend session", async () => {
    const session = {
      success: true,
      expiresAt: "2026-11-09T00:00:00.000Z",
    };
    globalThis.fetch = vi.fn(async () => jsonResponse(session));

    await expect(createDashboardSession("access-code", true)).resolves.toEqual(session);
    expect(fetch).toHaveBeenCalledWith(
      `${BACKEND}/api/auth/login`,
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ "Content-Type": "application/json" }),
        credentials: "include",
        body: JSON.stringify({ accessCode: "access-code", rememberMe: true }),
      }),
    );
  });

  it("restores an existing cookie-backed dashboard session", async () => {
    const session = {
      success: true,
      expiresAt: "2026-11-09T00:00:00.000Z",
    };
    globalThis.fetch = vi.fn(async () => jsonResponse(session));

    await expect(getDashboardSession()).resolves.toEqual(session);
    expect(fetch).toHaveBeenCalledWith(
      `${BACKEND}/api/auth/session`,
      expect.objectContaining({ method: "GET", credentials: "include" }),
    );
  });

  it("rejects an empty access code without a backend request", async () => {
    await expect(createDashboardSession("  ")).rejects.toThrow(
      /Enter the dashboard access code/,
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it("revokes the backend session on logout", async () => {
    globalThis.fetch = vi.fn(async () => jsonResponse({ success: true }));

    await expect(logoutDashboardSession()).resolves.toEqual({
      success: true,
    });
    expect(fetch).toHaveBeenCalledWith(
      `${BACKEND}/api/auth/logout`,
      expect.objectContaining({
        method: "POST",
        credentials: "include",
      }),
    );
  });

  it("checks backend health independently from device connectivity", async () => {
    globalThis.fetch = vi.fn(async (url) =>
      url === `${BACKEND}/api/health`
        ? jsonResponse({ status: "OK", websocketConnected: false })
        : jsonResponse({ connected: false, websocketConnected: false }),
    );

    await expect(getBackendHealth()).resolves.toMatchObject({ status: "OK" });
    await expect(getDeviceStatus()).resolves.toMatchObject({
      connected: false,
    });
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([
      `${BACKEND}/api/health`,
      `${BACKEND}/api/device/status`,
    ]);
    expect(fetch.mock.calls[1][1].credentials).toBe("include");
  });

  it("preserves HTTP 401 status for invalid or expired dashboard sessions", async () => {
    globalThis.fetch = vi.fn(async () =>
      jsonResponse({ success: false, message: "Unauthorized" }, 401),
    );

    await expect(getDeviceStatus()).rejects.toMatchObject({
      message: "Unauthorized",
      status: 401,
    });
  });

  it.each([
    ["connected", statusResponse({ connected: true, ip: "192.168.1.5" })],
    ["disconnected", statusResponse()],
    ["connecting", statusResponse({ connecting: true })],
  ])("returns %s status", async (_label, status) => {
    mockStatusThen(status);
    await expect(getStatus()).resolves.toMatchObject(status);
  });

  it("reports an unreachable ESP32", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new TypeError("network unreachable");
    });
    await expect(getStatus()).rejects.toThrow(/Cannot reach the ESP32/);
  });

  it("reports invalid JSON from the status endpoint", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response("{invalid", {
        headers: { "Content-Type": "application/json" },
      }),
    );
    await expect(getStatus()).rejects.toThrow(/invalid JSON/);
  });

  it.each([400, 500])("reports HTTP %s errors", async (code) => {
    globalThis.fetch = vi.fn(async () =>
      jsonResponse({ message: `server error ${code}` }, code),
    );
    await expect(sendNotice("Meeting")).rejects.toThrow(
      `server error ${code}`,
    );
  });

  it("sends notices through the authenticated backend and requires its delivery confirmation", async () => {
    const result = {
      success: true,
      delivered: true,
      message: "ESP32 acknowledged the notice command.",
    };
    globalThis.fetch = vi.fn(async () => jsonResponse(result));

    await expect(sendNotice(" Meeting at 10 ")).resolves.toEqual(
      result,
    );
    expect(fetch).toHaveBeenCalledWith(
      `${BACKEND}/api/notices`,
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "Content-Type": "application/json",
        }),
        body: JSON.stringify({ notice: "Meeting at 10" }),
      }),
    );
  });

  it("does not claim success if the backend did not confirm delivery", async () => {
    globalThis.fetch = vi.fn(async () =>
      jsonResponse({ success: true, message: "Notice queued" }),
    );
    await expect(sendNotice("Meeting")).rejects.toThrow(
      /Notice queued/,
    );
  });

  it("accepts a notice at the 200-character limit", async () => {
    globalThis.fetch = vi.fn(async () =>
      jsonResponse({ success: true, delivered: true, message: "Acknowledged" }),
    );
    const notice = "x".repeat(200);
    await expect(sendNotice(notice)).resolves.toMatchObject({
      delivered: true,
    });
    expect(JSON.parse(fetch.mock.calls[0][1].body).notice).toHaveLength(200);
  });

  it("rejects empty and overlength notices without a request", async () => {
    await expect(sendNotice("  ")).rejects.toThrow(
      /Enter a notice/,
    );
    await expect(
      sendNotice("x".repeat(201)),
    ).rejects.toThrow(/cannot exceed 200/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("blocks local ESP32 requests outside the local HTTP setup environment", async () => {
    vi.stubGlobal("window", {
      location: { protocol: "https:" },
      sessionStorage: window.sessionStorage,
    });
    await expect(getStatus()).rejects.toThrow(
      /local HTTP development dashboard/,
    );
    expect(fetch).not.toHaveBeenCalled();
  });
});
