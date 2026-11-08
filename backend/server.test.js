const { before, after, test } = require("node:test");
const assert = require("node:assert/strict");
const WebSocket = require("ws");

process.env.PORT = "0";
process.env.ESP32_DEVICE_TOKEN = "test-device-token";
process.env.DASHBOARD_ACCESS_CODE = "test-access-code";
process.env.DASHBOARD_ORIGIN =
    "http://localhost:5173,https://dashboard.example.test";
process.env.NOTICE_ACK_TIMEOUT_MS = "300";

const { server } = require("./server");
const DEVICE_TOKEN = process.env.ESP32_DEVICE_TOKEN;
const DASHBOARD_ACCESS_CODE = process.env.DASHBOARD_ACCESS_CODE;
let DASHBOARD_TOKEN = "";
let baseUrl;
let deviceSocket;

function dashboardHeaders(extra = {}) {
    return {
        Authorization: `Bearer ${DASHBOARD_TOKEN}`,
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
    DASHBOARD_TOKEN = session.sessionToken;
});

after(async () => {
    if (deviceSocket && deviceSocket.readyState === WebSocket.OPEN) {
        deviceSocket.close();
        await new Promise((resolve) => deviceSocket.once("close", resolve));
    }
    await new Promise((resolve) => server.close(resolve));
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

    const statusResponse = await fetch(`${baseUrl}/api/device/status`, {
        headers: { Authorization: `Bearer ${session.sessionToken}` }
    });
    assert.equal(statusResponse.status, 200);
});

test("device status and notice routes require dashboard authentication", async () => {
    const response = await fetch(`${baseUrl}/api/device/status`);
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), {
        success: false,
        message: "Dashboard session is invalid or expired."
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
