import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  connectWiFi,
  discoverESP32,
  disconnectWiFi,
  getESP32Address,
  getStatus,
  normalizeESP32Address,
  reconnectWiFi,
  sendNotice,
  setESP32Address,
} from "./esp32Service.js";

const ACCESS_POINT = "http://192.168.4.1";

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
    globalThis.fetch = vi.fn(async (url) =>
      url.endsWith("/status")
        ? jsonResponse(statusResponse())
        : jsonResponse({ message: `server error ${code}` }, code),
    );
    await expect(sendNotice("Meeting")).rejects.toThrow(
      `server error ${code}`,
    );
  });

  it("sends a notice to the address found by discovery", async () => {
    const requests = [];
    globalThis.fetch = vi.fn(async (url, options) => {
      requests.push({ url, options });
      return url.endsWith("/status")
        ? jsonResponse(
            statusResponse({
              connected: true,
              ssid: "Office",
              ip: "192.168.1.10",
            }),
          )
        : jsonResponse({ message: "notice displayed" });
    });

    await expect(sendNotice("Meeting at 10")).resolves.toMatchObject({
      message: "notice displayed",
    });
    expect(requests.at(-1).url).toBe(`${ACCESS_POINT}/notice`);
    expect(JSON.parse(requests.at(-1).options.body)).toEqual({
      notice: "Meeting at 10",
    });
  });

  it("rejects empty and overlength notices without making a request", async () => {
    await expect(sendNotice("  ")).rejects.toThrow(/Enter a notice/);
    await expect(sendNotice("x".repeat(201))).rejects.toThrow(
      /cannot exceed 200/,
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it("blocks mixed-content requests from an HTTPS dashboard", async () => {
    vi.stubGlobal("window", {
      location: { protocol: "https:" },
      sessionStorage: window.sessionStorage,
    });
    await expect(getStatus()).rejects.toThrow(/loaded over HTTPS/);
    expect(fetch).not.toHaveBeenCalled();
  });
});
