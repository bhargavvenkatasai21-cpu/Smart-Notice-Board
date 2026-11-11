const { before, after, test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const WebSocket = require("ws");

const sessionDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), "smart-notice-backend-test-")
);
process.env.PORT = "0";
process.env.ESP32_DEVICE_TOKEN = "test-device-token";
process.env.DASHBOARD_ACCESS_CODE = "test-access-code";
process.env.DASHBOARD_SESSION_STORE_PATH =
    path.join(sessionDirectory, "sessions.json");
process.env.DASHBOARD_ORIGIN =
    "http://localhost:5173,https://dashboard.example.test";
process.env.NOTICE_ACK_TIMEOUT_MS = "300";
process.env.WIFI_CONFIGURATION_TIMEOUT_MS = "500";
process.env.WIFI_FORGET_TIMEOUT_MS = "300";
process.env.FIRMWARE_UPDATE_TIMEOUT_MS = "500";

const { server } = require("./server");
const DEVICE_TOKEN = process.env.ESP32_DEVICE_TOKEN;
const DASHBOARD_ACCESS_CODE = process.env.DASHBOARD_ACCESS_CODE;
let DASHBOARD_COOKIE = "";
let baseUrl;
let deviceSocket;

function dashboardHeaders(extra = {}) {
    return {
        Cookie: DASHBOARD_COOKIE,
        "Content-Type": "application/json",
        ...extra
    };
}

async function connectDevice() {
    const socket = new WebSocket(`${baseUrl.replace("http", "ws")}/ws`);
    const authenticated = new Promise((resolve, reject) => {
        const timeout = setTimeout(
            () => reject(new Error("WebSocket authentication timed out")),
            1000
        );
        socket.on("message", (raw) => {
            const message = JSON.parse(raw.toString());
            if (message.type === "CONNECTION") {
                clearTimeout(timeout);
                resolve();
            }
        });
        socket.on("error", reject);
    });
    await new Promise((resolve, reject) => {
        socket.once("open", resolve);
        socket.once("error", reject);
    });
    socket.send(JSON.stringify({ type: "AUTH", token: DEVICE_TOKEN }));
    await authenticated;
    deviceSocket = socket;
    return socket;
}

before(async () => {
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    const response = await fetch(`${baseUrl}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accessCode: DASHBOARD_ACCESS_CODE })
    });
    const session = await response.json();
    assert.equal(response.status, 200);
    DASHBOARD_COOKIE = response.headers.get("set-cookie").split(";")[0];
    assert.equal(session.success, true);
});

after(async () => {
    if (deviceSocket && deviceSocket.readyState === WebSocket.OPEN) {
        deviceSocket.close();
        await new Promise((resolve) => deviceSocket.once("close", resolve));
    }
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(sessionDirectory, { recursive: true, force: true });
});

test("health endpoint is public and reports WebSocket connectivity", async () => {
    const response = await fetch(`${baseUrl}/api/health`, {
        headers: { Origin: "https://dashboard.example.test" }
    });
    assert.equal(response.status, 200);
    assert.equal(
        response.headers.get("access-control-allow-origin"),
        "https://dashboard.example.test"
    );
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.equal(response.headers.get("x-frame-options"), "DENY");
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.deepEqual(await response.json(), {
        status: "OK",
        service: "Smart Notice Board Backend",
        websocketConnected: false
    });
});

test("dashboard access code creates a session and rejects incorrect or empty codes", async () => {
    const emptyResponse = await fetch(`${baseUrl}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accessCode: "  " })
    });
    assert.equal(emptyResponse.status, 400);
    assert.equal((await emptyResponse.json()).message, "Enter the dashboard access code.");

    const invalidResponse = await fetch(`${baseUrl}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accessCode: "incorrect-code" })
    });
    assert.equal(invalidResponse.status, 401);
    assert.equal((await invalidResponse.json()).message, "Incorrect dashboard access code.");

    const loginResponse = await fetch(`${baseUrl}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accessCode: DASHBOARD_ACCESS_CODE, rememberMe: true })
    });
    const session = await loginResponse.json();
    assert.equal(loginResponse.status, 200);
    assert.equal(session.success, true);
    assert.equal(typeof session.sessionToken, "string");
    assert.equal(session.sessionToken.length, 64);
    assert.equal(typeof session.expiresAt, "string");
    assert.match(loginResponse.headers.get("set-cookie"), /Max-Age=2592000/);

    const statusResponse = await fetch(`${baseUrl}/api/device/status`, {
        headers: { Authorization: `Bearer ${session.sessionToken}` }
    });
    assert.equal(statusResponse.status, 200);
});

test("browser sessions use secure expiring cookies and survive refresh until logout", async () => {
    const origin = "https://dashboard.example.test";
    const loginResponse = await fetch(`${baseUrl}/api/auth/login`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            Origin: origin,
            "X-Forwarded-Proto": "https"
        },
        body: JSON.stringify({ accessCode: DASHBOARD_ACCESS_CODE })
    });
    const session = await loginResponse.json();
    const cookieHeader = loginResponse.headers.get("set-cookie");
    const cookie = cookieHeader.split(";")[0];

    assert.equal(loginResponse.status, 200);
    assert.equal(session.success, true);
    assert.equal("sessionToken" in session, false);
    assert.match(cookieHeader, /HttpOnly/);
    assert.match(cookieHeader, /Secure/);
    assert.match(cookieHeader, /SameSite=None/);
    assert.match(cookieHeader, /Max-Age=43200/);

    const restored = await fetch(`${baseUrl}/api/auth/session`, {
        headers: {
            Cookie: cookie,
            Origin: origin,
            "X-Forwarded-Proto": "https"
        }
    });
    assert.equal(restored.status, 200);
    assert.equal((await restored.json()).expiresAt, session.expiresAt);

    const logout = await fetch(`${baseUrl}/api/auth/logout`, {
        method: "POST",
        headers: {
            Cookie: cookie,
            Origin: origin,
            "X-Forwarded-Proto": "https"
        }
    });
    assert.equal(logout.status, 200);
    assert.match(logout.headers.get("set-cookie"), /Max-Age=0/);

    const afterLogout = await fetch(`${baseUrl}/api/auth/session`, {
        headers: {
            Cookie: cookie,
            Origin: origin,
            "X-Forwarded-Proto": "https"
        }
    });
    assert.equal(afterLogout.status, 401);
});

test("device status and notice routes require dashboard authentication", async () => {
    const response = await fetch(`${baseUrl}/api/device/status`);
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), {
        success: false,
        code: "session_missing",
        message: "Dashboard sign-in is required."
    });

    const invalidToken = await fetch(`${baseUrl}/api/notices`, {
        method: "POST",
        headers: dashboardHeaders({ Authorization: "Bearer wrong-token" }),
        body: JSON.stringify({ notice: "Test" })
    });
    assert.equal(invalidToken.status, 401);
});

test("malformed JSON receives a JSON client error", async () => {
      const response = await fetch(`${baseUrl}/api/notices`, {
          method: "POST",
          headers: dashboardHeaders(),
          body: "{invalid"
      });
      assert.equal(response.status, 400);
      assert.deepEqual(await response.json(), {
          success: false,
          message: "Request body must contain valid JSON."
      });
});

test("WebSocket closes connections that fail device authentication", async () => {
      const socket = new WebSocket(`${baseUrl.replace("http", "ws")}/ws`);
      const closed = new Promise((resolve, reject) => {
          socket.once("close", (code) => resolve(code));
          socket.once("error", reject);
      });
      await new Promise((resolve, reject) => {
          socket.once("open", resolve);
          socket.once("error", reject);
      });
      socket.send(JSON.stringify({ type: "AUTH", token: "wrong-device-token" }));
      assert.equal(await closed, 1008);
});

test("status accurately reports a disconnected device", async () => {
    const response = await fetch(`${baseUrl}/api/device/status`, {
        headers: dashboardHeaders()
    });
    assert.equal(response.status, 200);
    const status = await response.json();
    assert.equal(status.connected, false);
    assert.equal(status.websocketConnected, false);
    assert.equal(status.latestNotice, null);
});

test("notice requests validate content and report a disconnected device", async () => {
    for (const notice of ["", "  ", "x".repeat(201)]) {
        const response = await fetch(`${baseUrl}/api/notices`, {
            method: "POST",
            headers: dashboardHeaders(),
            body: JSON.stringify({ notice })
        });
        assert.equal(response.status, 400);
        assert.equal((await response.json()).success, false);
    }

    const response = await fetch(`${baseUrl}/api/notices`, {
        method: "POST",
        headers: dashboardHeaders(),
        body: JSON.stringify({ notice: "No board" })
    });
    assert.equal(response.status, 503);
    assert.equal((await response.json()).delivered, false);
});

test("Wi-Fi configuration requires a session, valid credentials, and a connected device", async () => {
    const unauthenticated = await fetch(`${baseUrl}/api/device/wifi-config`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ssid: "Office", password: "password123" })
    });
    assert.equal(unauthenticated.status, 401);

    for (const configuration of [
        { ssid: " ", password: "password123" },
        { ssid: "x".repeat(33), password: "password123" },
        { ssid: "Cafe", password: "short" },
        { ssid: "Cafe", password: 12345678 }
    ]) {
        const response = await fetch(`${baseUrl}/api/device/wifi-config`, {
            method: "POST",
            headers: dashboardHeaders(),
            body: JSON.stringify(configuration)
        });
        assert.equal(response.status, 400);
        assert.equal(JSON.stringify(await response.json()).includes(configuration.password), false);
    }

    const disconnected = await fetch(`${baseUrl}/api/device/wifi-config`, {
        method: "POST",
        headers: dashboardHeaders(),
        body: JSON.stringify({ ssid: "Office", password: "password123" })
    });
    assert.equal(disconnected.status, 503);
});

test("Wi-Fi configuration tracks request IDs through reconnect and never returns its password", async () => {
    const oldSocket = await connectDevice();
    const commandReceived = new Promise((resolve, reject) => {
        const timeout = setTimeout(
            () => reject(new Error("Wi-Fi configuration command was not sent")),
            1000
        );
        oldSocket.once("message", (raw) => {
            clearTimeout(timeout);
            resolve(JSON.parse(raw.toString()));
        });
    });

    const configurationResponse = await fetch(`${baseUrl}/api/device/wifi-config`, {
        method: "POST",
        headers: dashboardHeaders(),
        body: JSON.stringify({ ssid: "New office", password: "new-password" })
    });
    const initialResult = await configurationResponse.json();
    const command = await commandReceived;
    assert.equal(configurationResponse.status, 202);
    assert.equal(command.type, "WIFI_CONFIG");
    assert.equal(command.requestId, initialResult.requestId);
    assert.equal(command.ssid, "New office");
    assert.equal(command.password, "new-password");
    assert.equal(JSON.stringify(initialResult).includes("new-password"), false);

    oldSocket.send(JSON.stringify({
        type: "WIFI_CONFIG_STATUS",
        requestId: command.requestId,
        state: "accepted"
    }));
    oldSocket.send(JSON.stringify({
        type: "WIFI_CONFIG_STATUS",
        requestId: command.requestId,
        state: "connecting"
    }));

    const duplicate = await fetch(`${baseUrl}/api/device/wifi-config`, {
        method: "POST",
        headers: dashboardHeaders(),
        body: JSON.stringify({ ssid: "Another network", password: "another-pass" })
    });
    assert.equal(duplicate.status, 409);

    oldSocket.send(JSON.stringify({
        type: "WIFI_CONFIG_STATUS",
        requestId: "00000000-0000-4000-8000-000000000000",
        state: "wifi_connected"
    }));
    oldSocket.close();
    await new Promise((resolve) => oldSocket.once("close", resolve));

    const newSocket = await connectDevice();
    newSocket.send(JSON.stringify({
        type: "DEVICE_STATUS",
        connected: true,
        ssid: "New office",
        ip: "192.168.10.20",
        rssi: -61,
        firmwareVersion: "1.0.0"
    }));
    newSocket.send(JSON.stringify({
        type: "WIFI_CONFIG_STATUS",
        requestId: command.requestId,
        state: "wifi_connected"
    }));
    newSocket.send(JSON.stringify({
        type: "WIFI_CONFIG_STATUS",
        requestId: command.requestId,
        state: "authenticated",
        ssid: "New office",
        ip: "192.168.10.20"
    }));

    await new Promise((resolve) => setTimeout(resolve, 10));
    const operationResponse = await fetch(
        `${baseUrl}/api/device/wifi-config/${command.requestId}`,
        { headers: dashboardHeaders() }
    );
    const operationResult = await operationResponse.json();
    assert.equal(operationResponse.status, 200);
    assert.equal(operationResult.operation.state, "authenticated");
    assert.equal(operationResult.operation.ssid, "New office");
    assert.equal(operationResult.operation.ip, "192.168.10.20");
    assert.equal(JSON.stringify(operationResult).includes("new-password"), false);

    const statusResponse = await fetch(`${baseUrl}/api/device/status`, {
        headers: dashboardHeaders()
    });
    const status = await statusResponse.json();
    assert.deepEqual(status.wifi, {
        connected: true,
        ssid: "New office",
        ip: "192.168.10.20",
        rssi: -61,
        firmwareVersion: "1.0.0",
        lastConnectedAt: status.wifi.lastConnectedAt
    });
    assert.ok(status.wifi.lastConnectedAt);

    newSocket.close();
    await new Promise((resolve) => newSocket.once("close", resolve));
    deviceSocket = null;
});

test("Wi-Fi configuration timeout is reported when the ESP32 never reconnects", async () => {
    const socket = await connectDevice();
    const commandReceived = new Promise((resolve, reject) => {
        const timeout = setTimeout(
            () => reject(new Error("Wi-Fi configuration command was not sent")),
            1000
        );
        socket.once("message", (raw) => {
            clearTimeout(timeout);
            resolve(JSON.parse(raw.toString()));
        });
    });
    const response = await fetch(`${baseUrl}/api/device/wifi-config`, {
        method: "POST",
        headers: dashboardHeaders(),
        body: JSON.stringify({ ssid: "Office", password: "password123" })
    });
    const result = await response.json();
    const command = await commandReceived;
    assert.equal(command.requestId, result.requestId);

    socket.send(JSON.stringify({
        type: "WIFI_CONFIG_STATUS",
        requestId: command.requestId,
        state: "accepted"
    }));
    socket.send(JSON.stringify({
        type: "WIFI_CONFIG_STATUS",
        requestId: command.requestId,
        state: "connecting"
    }));
    socket.close();
    await new Promise((resolve) => socket.once("close", resolve));
    deviceSocket = null;
    await new Promise((resolve) => setTimeout(resolve, 550));

    const statusResponse = await fetch(
        `${baseUrl}/api/device/wifi-config/${command.requestId}`,
        { headers: dashboardHeaders() }
    );
    const status = await statusResponse.json();
    assert.equal(status.operation.state, "timed_out");
    assert.match(status.operation.message, /Wi-Fi may have connected/);
    assert.equal(JSON.stringify(status).includes("password123"), false);
});

test("Wi-Fi credential deletion requires a connected authenticated device", async () => {
    const unauthenticated = await fetch(`${baseUrl}/api/device/wifi-forget`, {
        method: "POST",
        headers: { "Content-Type": "application/json" }
    });
    assert.equal(unauthenticated.status, 401);

    const disconnected = await fetch(`${baseUrl}/api/device/wifi-forget`, {
        method: "POST",
        headers: dashboardHeaders()
    });
    assert.equal(disconnected.status, 503);
});

test("Wi-Fi credential deletion reports confirmed, failed, and timed-out operations", async () => {
    const socket = await connectDevice();

    const requestForget = async () => {
        const commandReceived = new Promise((resolve, reject) => {
            const timeout = setTimeout(
                () => reject(new Error("Wi-Fi forget command was not sent")),
                1000
            );
            socket.once("message", (raw) => {
                clearTimeout(timeout);
                resolve(JSON.parse(raw.toString()));
            });
        });
        const response = await fetch(`${baseUrl}/api/device/wifi-forget`, {
            method: "POST",
            headers: dashboardHeaders()
        });
        const result = await response.json();
        return { response, result, command: await commandReceived };
    };

    const failed = await requestForget();
    assert.equal(failed.response.status, 202);
    assert.equal(failed.command.type, "WIFI_FORGET");
    assert.equal(failed.command.requestId, failed.result.requestId);
    assert.equal(JSON.stringify(failed.result).includes("password"), false);

    const duplicate = await fetch(`${baseUrl}/api/device/wifi-forget`, {
        method: "POST",
        headers: dashboardHeaders()
    });
    assert.equal(duplicate.status, 409);

    socket.send(JSON.stringify({
        type: "WIFI_FORGET_STATUS",
        requestId: failed.command.requestId,
        state: "accepted"
    }));
    socket.send(JSON.stringify({
        type: "WIFI_FORGET_STATUS",
        requestId: failed.command.requestId,
        state: "failed"
    }));
    await new Promise((resolve) => setTimeout(resolve, 10));

    let statusResponse = await fetch(
        `${baseUrl}/api/device/wifi-forget/${failed.command.requestId}`,
        { headers: dashboardHeaders() }
    );
    let status = await statusResponse.json();
    assert.equal(statusResponse.status, 200);
    assert.equal(status.operation.state, "failed");

    const deleted = await requestForget();
    socket.send(JSON.stringify({
        type: "WIFI_FORGET_STATUS",
        requestId: deleted.command.requestId,
        state: "accepted"
    }));
    socket.send(JSON.stringify({
        type: "WIFI_FORGET_STATUS",
        requestId: deleted.command.requestId,
        state: "deleted"
    }));
    await new Promise((resolve) => setTimeout(resolve, 10));

    statusResponse = await fetch(
        `${baseUrl}/api/device/wifi-forget/${deleted.command.requestId}`,
        { headers: dashboardHeaders() }
    );
    status = await statusResponse.json();
    assert.equal(status.operation.state, "deleted");

    const timedOut = await requestForget();
    await new Promise((resolve) => setTimeout(resolve, 350));
    statusResponse = await fetch(
        `${baseUrl}/api/device/wifi-forget/${timedOut.command.requestId}`,
        { headers: dashboardHeaders() }
    );
    status = await statusResponse.json();
    assert.equal(status.operation.state, "timed_out");

    socket.close();
    await new Promise((resolve) => socket.once("close", resolve));
    deviceSocket = null;
});

test("firmware update is authorized, tracked, and verified after device reconnects", async () => {
    const unauthenticated = await fetch(
        `${baseUrl}/api/device/firmware-update`,
        {
            method: "POST",
            headers: { "Content-Type": "application/json" }
        }
    );
    assert.equal(unauthenticated.status, 401);

    const disconnected = await fetch(
        `${baseUrl}/api/device/firmware-update`,
        {
            method: "POST",
            headers: dashboardHeaders()
        }
    );
    assert.equal(disconnected.status, 503);

    const socket = await connectDevice();
    const commandReceived = new Promise((resolve, reject) => {
        const timeout = setTimeout(
            () => reject(new Error("Firmware update command was not sent")),
            1000
        );
        socket.once("message", (raw) => {
            clearTimeout(timeout);
            resolve(JSON.parse(raw.toString()));
        });
    });
    const response = await fetch(`${baseUrl}/api/device/firmware-update`, {
        method: "POST",
        headers: dashboardHeaders()
    });
    const started = await response.json();
    const command = await commandReceived;
    assert.equal(response.status, 202);
    assert.equal(command.type, "FIRMWARE_UPDATE");
    assert.equal(command.requestId, started.requestId);

    const duplicate = await fetch(`${baseUrl}/api/device/firmware-update`, {
        method: "POST",
        headers: dashboardHeaders()
    });
    assert.equal(duplicate.status, 409);

    for (const state of ["checking", "downloading", "verifying", "rebooting"]) {
        socket.send(JSON.stringify({
            type: "FIRMWARE_UPDATE_STATUS",
            requestId: command.requestId,
            state,
            ...(state === "rebooting" ? { version: "1.0.1" } : {})
        }));
    }
    socket.close();
    await new Promise((resolve) => socket.once("close", resolve));
    deviceSocket = null;

    const updatedSocket = await connectDevice();
    updatedSocket.send(JSON.stringify({
        type: "DEVICE_STATUS",
        connected: true,
        ssid: "Office",
        ip: "192.168.10.20",
        rssi: -58,
        firmwareVersion: "1.0.1"
    }));
    await new Promise((resolve) => setTimeout(resolve, 10));

    let statusResponse = await fetch(
        `${baseUrl}/api/device/firmware-update/${command.requestId}`,
        { headers: dashboardHeaders() }
    );
    let status = await statusResponse.json();
    assert.equal(statusResponse.status, 200);
    assert.equal(status.operation.state, "verified");
    assert.equal(status.operation.version, "1.0.1");

    const failedCommand = new Promise((resolve, reject) => {
        const timeout = setTimeout(
            () => reject(new Error("Second firmware update command was not sent")),
            1000
        );
        updatedSocket.once("message", (raw) => {
            clearTimeout(timeout);
            resolve(JSON.parse(raw.toString()));
        });
    });
    const failedResponse = await fetch(
        `${baseUrl}/api/device/firmware-update`,
        { method: "POST", headers: dashboardHeaders() }
    );
    const failedStart = await failedResponse.json();
    const failedUpdateCommand = await failedCommand;
    updatedSocket.send(JSON.stringify({
        type: "FIRMWARE_UPDATE_STATUS",
        requestId: failedUpdateCommand.requestId,
        state: "failed",
        message: "OTA public key is not configured."
    }));
    await new Promise((resolve) => setTimeout(resolve, 10));
    statusResponse = await fetch(
        `${baseUrl}/api/device/firmware-update/${failedStart.requestId}`,
        { headers: dashboardHeaders() }
    );
    status = await statusResponse.json();
    assert.equal(status.operation.state, "failed");
    assert.equal(status.operation.message, "OTA public key is not configured.");

    const timedOutCommand = new Promise((resolve, reject) => {
        const timeout = setTimeout(
            () => reject(new Error("Third firmware update command was not sent")),
            1000
        );
        updatedSocket.once("message", (raw) => {
            clearTimeout(timeout);
            resolve(JSON.parse(raw.toString()));
        });
    });
    const timedOutResponse = await fetch(
        `${baseUrl}/api/device/firmware-update`,
        { method: "POST", headers: dashboardHeaders() }
    );
    const timedOutStart = await timedOutResponse.json();
    const timedOutUpdateCommand = await timedOutCommand;
    await new Promise((resolve) => setTimeout(resolve, 550));
    statusResponse = await fetch(
        `${baseUrl}/api/device/firmware-update/${timedOutStart.requestId}`,
        { headers: dashboardHeaders() }
    );
    status = await statusResponse.json();
    assert.equal(status.operation.state, "timed_out");

    updatedSocket.close();
    await new Promise((resolve) => updatedSocket.once("close", resolve));
    deviceSocket = null;
});

test("firmware release check is separate and never commands installation", async () => {
    const socket = await connectDevice();
    const commandReceived = new Promise((resolve, reject) => {
        const timeout = setTimeout(
            () => reject(new Error("Firmware release check was not sent")),
            1000
        );
        socket.once("message", (raw) => {
            clearTimeout(timeout);
            resolve(JSON.parse(raw.toString()));
        });
    });

    const response = await fetch(`${baseUrl}/api/device/firmware-check`, {
        method: "POST",
        headers: dashboardHeaders()
    });
    const started = await response.json();
    const command = await commandReceived;
    assert.equal(response.status, 202);
    assert.equal(command.type, "FIRMWARE_CHECK");
    assert.equal(command.requestId, started.requestId);
    assert.equal("allowReinstall" in command, false);

    socket.send(JSON.stringify({
        type: "FIRMWARE_UPDATE_STATUS",
        requestId: command.requestId,
        state: "checking"
    }));
    socket.send(JSON.stringify({
        type: "FIRMWARE_UPDATE_STATUS",
        requestId: command.requestId,
        state: "available",
        version: "1.0.4"
    }));
    await new Promise((resolve) => setTimeout(resolve, 10));

    const statusResponse = await fetch(
        `${baseUrl}/api/device/firmware-update/${command.requestId}`,
        { headers: dashboardHeaders() }
    );
    const status = await statusResponse.json();
    assert.equal(status.operation.state, "available");
    assert.equal(status.operation.version, "1.0.4");

    socket.close();
    await new Promise((resolve) => socket.once("close", resolve));
    deviceSocket = null;
});

test("authenticated ESP32 receives notices and confirms delivery", async () => {
    const socket = await connectDevice();
    const noticeReceived = new Promise((resolve, reject) => {
        const timeout = setTimeout(
            () => reject(new Error("Notice was not sent to the ESP32")),
            1000
        );
        socket.once("message", (raw) => {
            clearTimeout(timeout);
            const message = JSON.parse(raw.toString());
            resolve(message);
            socket.send(JSON.stringify({
                type: "NOTICE_ACK",
                id: message.id,
                success: true
            }));
        });
    });

    const responsePromise = fetch(`${baseUrl}/api/notices`, {
        method: "POST",
        headers: dashboardHeaders(),
        body: JSON.stringify({ notice: "Meeting at 10" })
    });
    const deliveredMessage = await noticeReceived;
    const response = await responsePromise;
    const result = await response.json();

    assert.equal(response.status, 200);
    assert.equal(deliveredMessage.type, "NOTICE");
    assert.equal(deliveredMessage.notice, "Meeting at 10");
    assert.equal(typeof deliveredMessage.id, "string");
    assert.equal(result.success, true);
    assert.equal(result.delivered, true);
    assert.match(result.message, /Physical LCD output cannot be verified/);

    const statusResponse = await fetch(`${baseUrl}/api/device/status`, {
        headers: dashboardHeaders()
    });
    const status = await statusResponse.json();
    assert.equal(status.connected, true);
    assert.equal(status.websocketConnected, true);
    assert.equal(status.latestNotice.notice, "Meeting at 10");
    assert.ok(status.lastSeenAt);

    socket.close();
    await new Promise((resolve) => socket.once("close", resolve));
    deviceSocket = null;
});

test("backend accepts a notice exactly 200 characters long", async () => {
    const socket = await connectDevice();
    const noticeText = "n".repeat(200);
    const received = new Promise((resolve, reject) => {
        const timeout = setTimeout(
            () => reject(new Error("Maximum-length notice was not sent")),
            1000
        );
        socket.once("message", (raw) => {
            clearTimeout(timeout);
            const message = JSON.parse(raw.toString());
            resolve(message);
            socket.send(JSON.stringify({
                type: "NOTICE_ACK",
                id: message.id,
                success: true
            }));
        });
    });

    const responsePromise = fetch(`${baseUrl}/api/notices`, {
        method: "POST",
        headers: dashboardHeaders(),
        body: JSON.stringify({ notice: noticeText })
    });
    const sentNotice = await received;
    const response = await responsePromise;
    assert.equal(response.status, 200);
    assert.equal(sentNotice.notice.length, 200);
    assert.equal((await response.json()).delivered, true);

    socket.close();
    await new Promise((resolve) => socket.once("close", resolve));
    deviceSocket = null;
});

test("notice delivery fails instead of reporting success without ESP32 acknowledgement", async () => {
    const socket = await connectDevice();
    socket.once("message", () => {});

    const response = await fetch(`${baseUrl}/api/notices`, {
        method: "POST",
        headers: dashboardHeaders(),
        body: JSON.stringify({ notice: "No acknowledgement" })
    });
    assert.equal(response.status, 504);
    assert.deepEqual(await response.json(), {
        success: false,
        delivered: false,
        message: "ESP32 did not acknowledge the notice in time."
    });

    socket.close();
    await new Promise((resolve) => socket.once("close", resolve));
    deviceSocket = null;
});

test("logout revokes the dashboard session", async () => {
    const loginResponse = await fetch(`${baseUrl}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accessCode: DASHBOARD_ACCESS_CODE })
    });
    const session = await loginResponse.json();

    const logoutResponse = await fetch(`${baseUrl}/api/auth/logout`, {
        method: "POST",
        headers: { Authorization: `Bearer ${session.sessionToken}` }
    });
    assert.equal(logoutResponse.status, 200);
    assert.deepEqual(await logoutResponse.json(), { success: true });

    const statusResponse = await fetch(`${baseUrl}/api/device/status`, {
        headers: { Authorization: `Bearer ${session.sessionToken}` }
    });
    assert.equal(statusResponse.status, 401);
});

test("login rate limiting blocks repeated incorrect access codes", async () => {
    const headers = {
        "Content-Type": "application/json",
        "X-Forwarded-For": "203.0.113.77"
    };

    for (let attempt = 0; attempt < 10; attempt += 1) {
        const response = await fetch(`${baseUrl}/api/auth/login`, {
            method: "POST",
            headers,
            body: JSON.stringify({ accessCode: "incorrect-rate-limit-code" })
        });
        assert.equal(response.status, 401);
    }

    const limited = await fetch(`${baseUrl}/api/auth/login`, {
        method: "POST",
        headers,
        body: JSON.stringify({ accessCode: DASHBOARD_ACCESS_CODE })
    });
    assert.equal(limited.status, 429);
    assert.equal(limited.headers.get("retry-after") !== null, true);
});
