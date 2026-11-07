import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import {
  connectWiFi,
  disconnectWiFi,
  getDeviceBaseUrl,
  getStatus,
  normalizeDeviceBaseUrl,
  reconnectWiFi,
  saveDeviceBaseUrl,
  sendNotice,
} from "./esp32Service.js";

const originalWindow = globalThis.window;
const originalFetch = globalThis.fetch;

beforeEach(() => {
  const values = new Map();
  globalThis.window = {
    localStorage: {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, value),
    },
  };
});

afterEach(() => {
  globalThis.window = originalWindow;
  globalThis.fetch = originalFetch;
});

function respond(body, status = 200) {
  globalThis.fetch = async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
}

test("normalizes valid device IPs and host names", () => {
  assert.equal(normalizeDeviceBaseUrl("192.168.4.1"), "http://192.168.4.1");
  assert.equal(
    normalizeDeviceBaseUrl("https://notice-board.local:8443/"),
    "https://notice-board.local:8443",
  );
  assert.throws(() => normalizeDeviceBaseUrl(""), /Enter the ESP32/);
  assert.throws(() => normalizeDeviceBaseUrl("http://device.local/api"), /no credentials or path/);
  assert.throws(() => normalizeDeviceBaseUrl("ftp://device.local"), /HTTP\(S\)/);
});

test("persists the selected address and uses it for API requests", async () => {
  assert.equal(saveDeviceBaseUrl("192.168.1.42"), "http://192.168.1.42");
  assert.equal(getDeviceBaseUrl(), "http://192.168.1.42");
  let requestUrl = "";
  globalThis.fetch = async (url) => {
    requestUrl = url;
    return new Response(
      JSON.stringify({
        connected: true,
        connecting: false,
        ip: "192.168.1.42",
        ssid: "Test network",
        apIp: "192.168.4.1",
        connectionError: "",
      }),
      { headers: { "Content-Type": "application/json" } },
    );
  };

  const status = await getStatus();
  assert.equal(status.connected, true);
  assert.equal(status.ip, "192.168.1.42");
  assert.equal(requestUrl, "http://192.168.1.42/status");
});

test("sends Wi-Fi and notice requests to their matching endpoints", async () => {
  const requests = [];
  globalThis.fetch = async (url, options) => {
    requests.push({ url, options });
    return new Response(JSON.stringify({ message: "accepted" }), {
      status: 202,
      headers: { "Content-Type": "application/json" },
    });
  };

  await connectWiFi("Office WiFi", "password123");
  await disconnectWiFi();
  await reconnectWiFi();
  await sendNotice("Meeting at 10");

  assert.deepEqual(
    requests.map(({ url }) => url),
    [
      "http://192.168.4.1/connect",
      "http://192.168.4.1/disconnect",
      "http://192.168.4.1/reconnect",
      "http://192.168.4.1/notice",
    ],
  );
  assert.equal(requests[0].options.method, "POST");
  assert.equal(
    requests[0].options.headers["Content-Type"],
    "application/json",
  );
  assert.deepEqual(JSON.parse(requests[0].options.body), {
    ssid: "Office WiFi",
    password: "password123",
  });
  assert.equal(requests[1].options.method, "POST");
  assert.equal(requests[1].options.body, undefined);
  assert.equal(requests[2].options.method, "POST");
  assert.equal(requests[2].options.body, undefined);
  assert.deepEqual(JSON.parse(requests[3].options.body), {
    notice: "Meeting at 10",
  });
});

test("surfaces API errors and invalid status responses", async () => {
  respond({ message: "WiFi name is required" }, 400);
  await assert.rejects(connectWiFi("", ""), /WiFi name is required/);

  respond({ connecting: false });
  await assert.rejects(getStatus(), /invalid Wi-Fi status/);
});

test("reports the configured device address when fetch cannot reach it", async () => {
  saveDeviceBaseUrl("192.168.9.9");
  globalThis.fetch = async () => {
    throw new TypeError("fetch failed");
  };

  await assert.rejects(getStatus(), /Cannot reach the ESP32 at http:\/\/192\.168\.9\.9/);
});

test("explains when a secure dashboard would make a blocked HTTP request", async () => {
  globalThis.window.location = { protocol: "https:" };
  await assert.rejects(getStatus(), /dashboard is loaded over HTTPS/);
});
