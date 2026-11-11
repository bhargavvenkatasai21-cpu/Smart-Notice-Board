
const express = require("express");
const cors = require("cors");
const http = require("http");
const crypto = require("crypto");
const path = require("node:path");
const WebSocket = require("ws");
const { createSessionStore } = require("./sessionStore");
require("dotenv").config();

const app = express();
const server = http.createServer(app);
app.disable("x-powered-by");
app.set("trust proxy", 1);

const PORT = process.env.PORT || 5000;
const DEVICE_TOKEN = process.env.ESP32_DEVICE_TOKEN;
const DASHBOARD_ACCESS_CODE = process.env.DASHBOARD_ACCESS_CODE;
const MAX_NOTICE_LENGTH = 200;
const NOTICE_ACK_TIMEOUT_MS = Number(process.env.NOTICE_ACK_TIMEOUT_MS) || 10000;
const WIFI_CONFIGURATION_TIMEOUT_MS =
    Number(process.env.WIFI_CONFIGURATION_TIMEOUT_MS) || 120000;
const WIFI_CONFIGURATION_RETENTION_MS = 10 * 60 * 1000;
const WIFI_FORGET_TIMEOUT_MS =
    Number(process.env.WIFI_FORGET_TIMEOUT_MS) || 10000;
const FIRMWARE_UPDATE_TIMEOUT_MS =
    Number(process.env.FIRMWARE_UPDATE_TIMEOUT_MS) || 5 * 60 * 1000;
const FIRMWARE_CHECK_TIMEOUT_MS =
    Number(process.env.FIRMWARE_CHECK_TIMEOUT_MS) || 30000;
const LOGIN_RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_RATE_LIMIT_MAX_ATTEMPTS = 10;
const LOGIN_RATE_LIMIT_MAX_CLIENTS = 10000;
const DASHBOARD_SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const REMEMBERED_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const DASHBOARD_SESSION_COOKIE = "snb_dashboard_session";
const DASHBOARD_ORIGINS = (process.env.DASHBOARD_ORIGIN || "http://localhost:5173")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);

if (!DEVICE_TOKEN || !DASHBOARD_ACCESS_CODE) {
    throw new Error("Missing ESP32_DEVICE_TOKEN or DASHBOARD_ACCESS_CODE in .env");
}

if (process.env.NODE_ENV === "production" && !process.env.DASHBOARD_SESSION_STORE_PATH) {
    throw new Error(
        "DASHBOARD_SESSION_STORE_PATH must point to a persistent Render disk location."
    );
}

const dashboardSessions = createSessionStore(
    process.env.DASHBOARD_SESSION_STORE_PATH ||
    path.join(__dirname, "data", "dashboard-sessions.json")
);

app.use((req, res, next) => {
    res.set({
        "Cache-Control": "no-store",
        "Content-Security-Policy": "default-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
        "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
        "Referrer-Policy": "no-referrer",
        "X-Content-Type-Options": "nosniff",
        "X-Frame-Options": "DENY"
    });
    if (req.secure) {
        res.setHeader(
            "Strict-Transport-Security",
            "max-age=31536000; includeSubDomains"
        );
    }
    next();
});

app.use(cors({
    origin: DASHBOARD_ORIGINS,
    methods: ["GET", "POST"],
    allowedHeaders: ["Content-Type"],
    credentials: true
}));

app.use(express.json({ limit: "10kb" }));

app.use((req, res, next) => {
    const origin = req.get("Origin");
    if (
        req.method === "POST" &&
        origin &&
        !DASHBOARD_ORIGINS.includes(origin)
    ) {
        return res.status(403).json({
            success: false,
            message: "This origin is not allowed to perform dashboard actions."
        });
    }
    next();
});

// Compare tokens safely
function verifyToken(provided, expected) {
    if (typeof provided !== "string") return false;

    const a = Buffer.from(provided);
    const b = Buffer.from(expected);

    return a.length === b.length &&
        crypto.timingSafeEqual(a, b);
}

const loginAttempts = new Map();

function isLoginRateLimited(clientAddress, now = Date.now()) {
    for (const [address, attempts] of loginAttempts) {
        if (attempts.resetAt <= now) {
            loginAttempts.delete(address);
        }
    }

    const attempts = loginAttempts.get(clientAddress);
    if (attempts && attempts.count >= LOGIN_RATE_LIMIT_MAX_ATTEMPTS) {
        return attempts.resetAt > now;
    }
    return false;
}

function recordLoginFailure(clientAddress, now = Date.now()) {
    let attempts = loginAttempts.get(clientAddress);
    if (!attempts || attempts.resetAt <= now) {
        if (
            !loginAttempts.has(clientAddress) &&
            loginAttempts.size >= LOGIN_RATE_LIMIT_MAX_CLIENTS
        ) {
            const oldestAddress = loginAttempts.keys().next().value;
            if (oldestAddress !== undefined) {
                loginAttempts.delete(oldestAddress);
            }
        }
        attempts = {
            count: 0,
            resetAt: now + LOGIN_RATE_LIMIT_WINDOW_MS
        };
        loginAttempts.set(clientAddress, attempts);
    }
    attempts.count += 1;
}

function hashSessionToken(token) {
    return crypto.createHash("sha256").update(token).digest("hex");
}

function readDashboardSessionCookie(req) {
    const cookieHeader = req.headers.cookie || "";
    const cookie = cookieHeader
        .split(";")
        .map((entry) => entry.trim())
        .find((entry) => entry.startsWith(`${DASHBOARD_SESSION_COOKIE}=`));
    const token = cookie?.slice(DASHBOARD_SESSION_COOKIE.length + 1) || "";
    return /^[a-f0-9]{64}$/.test(token) ? token : "";
}

function setDashboardSessionCookie(req, res, sessionToken, ttlMs) {
    const secure = req.secure;
    res.setHeader(
        "Set-Cookie",
        `${DASHBOARD_SESSION_COOKIE}=${sessionToken}; Path=/; HttpOnly; SameSite=${secure ? "None" : "Lax"}; Max-Age=${Math.floor(ttlMs / 1000)}${secure ? "; Secure" : ""}`
    );
}

function clearDashboardSessionCookie(req, res) {
    const secure = req.secure;
    res.setHeader(
        "Set-Cookie",
        `${DASHBOARD_SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=${secure ? "None" : "Lax"}; Max-Age=0${secure ? "; Secure" : ""}`
    );
}

function createDashboardSession(rememberMe) {
    const sessionToken = crypto.randomBytes(32).toString("hex");
    const now = Date.now();
    dashboardSessions.pruneExpired(now);
    const expiresAt = now +
        (rememberMe ? REMEMBERED_SESSION_TTL_MS : DASHBOARD_SESSION_TTL_MS);
    dashboardSessions.set(hashSessionToken(sessionToken), expiresAt);
    return {
        sessionToken,
        expiresAt,
        ttlMs: rememberMe ? REMEMBERED_SESSION_TTL_MS : DASHBOARD_SESSION_TTL_MS
    };
}

// Dashboard authentication
function authenticateDashboard(req, res, next) {
    const authorization = req.headers.authorization || "";
    const legacyBearerToken = !req.get("Origin") &&
        authorization.startsWith("Bearer ")
        ? authorization.slice(7)
        : "";
    const sessionToken = legacyBearerToken || readDashboardSessionCookie(req);
    const sessionKey = sessionToken ? hashSessionToken(sessionToken) : "";
    const expiresAt = dashboardSessions.get(sessionKey);

    if (!expiresAt || expiresAt <= Date.now()) {
        if (sessionKey) dashboardSessions.delete(sessionKey);
        if (sessionToken) clearDashboardSessionCookie(req, res);
        return res.status(401).json({
            success: false,
            code: sessionToken ? "session_invalid" : "session_missing",
            message: sessionToken
                ? "Dashboard session is invalid or expired."
                : "Dashboard sign-in is required."
        });
    }

    req.dashboardSessionKey = sessionKey;
    req.dashboardSessionExpiresAt = expiresAt;
    next();
}

app.post("/api/auth/login", (req, res) => {
    const clientAddress = req.ip || req.socket.remoteAddress || "unknown";
    if (isLoginRateLimited(clientAddress)) {
        const attempts = loginAttempts.get(clientAddress);
        res.setHeader(
            "Retry-After",
            Math.max(1, Math.ceil((attempts.resetAt - Date.now()) / 1000))
        );
        return res.status(429).json({
            success: false,
            message: "Too many sign-in attempts. Try again later."
        });
    }

    const accessCode = req.body?.accessCode;
    if (typeof accessCode !== "string" || !accessCode.trim()) {
        return res.status(400).json({
            success: false,
            message: "Enter the dashboard access code."
        });
    }

    if (!verifyToken(accessCode, DASHBOARD_ACCESS_CODE)) {
        recordLoginFailure(clientAddress);
        return res.status(401).json({
            success: false,
            message: "Incorrect dashboard access code."
        });
    }

    loginAttempts.delete(clientAddress);
    const session = createDashboardSession(req.body?.rememberMe === true);
    setDashboardSessionCookie(req, res, session.sessionToken, session.ttlMs);
    const response = {
        success: true,
        expiresAt: new Date(session.expiresAt).toISOString()
    };
    if (!req.get("Origin")) {
        response.sessionToken = session.sessionToken;
    }
    return res.json(response);
});

app.post("/api/auth/logout", authenticateDashboard, (req, res) => {
    dashboardSessions.delete(req.dashboardSessionKey);
    clearDashboardSessionCookie(req, res);
    return res.json({ success: true });
});

app.get("/api/auth/session", authenticateDashboard, (req, res) => {
    return res.json({
        success: true,
        expiresAt: new Date(req.dashboardSessionExpiresAt).toISOString()
    });
});

// Health check
app.get("/", (req, res) => {
    res.json({
        success: true,
        message: "Smart Notice Board Backend is running"
    });
});

app.get("/api/health", (req, res) => {
    res.json({
        status: "OK",
        service: "Smart Notice Board Backend",
        websocketConnected: Boolean(
            connectedDevice &&
            connectedDevice.readyState === WebSocket.OPEN
        )
    });
});

// WebSocket server
const wss = new WebSocket.Server({
    server,
    path: "/ws",
    maxPayload: 4096
});

// Check ESP32 connection every 15 seconds.
const heartbeatInterval = setInterval(() => {
    if (!connectedDevice) return;

    if (connectedDevice.readyState !== WebSocket.OPEN) return;

    if (connectedDevice.isAlive === false) {
        console.log("ESP32 heartbeat timeout. Terminating connection.");
        connectedDevice.terminate();
        return;
    }

    connectedDevice.isAlive = false;
    connectedDevice.ping();
}, 5000);
heartbeatInterval.unref();
server.on("close", () => clearInterval(heartbeatInterval));

let connectedDevice = null;
let latestNotice = null;
let lastDeviceCommunicationAt = null;
const pendingNotices = new Map();
const wifiConfigurationOperations = new Map();
let activeWifiConfigurationId = null;
const wifiForgetOperations = new Map();
let activeWifiForgetId = null;
const firmwareUpdateOperations = new Map();
let activeFirmwareUpdateId = null;
let deviceWifiStatus = {
    connected: false,
    ssid: "",
    ip: "",
    rssi: null,
    firmwareVersion: null,
    lastConnectedAt: null
};

function isRequestId(value) {
    return typeof value === "string" &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function cleanWifiConfigurationOperations() {
    const now = Date.now();
    for (const [id, operation] of wifiConfigurationOperations) {
        if (operation.expiresAt && operation.expiresAt <= now) {
            wifiConfigurationOperations.delete(id);
        }
    }
}

function cleanWifiForgetOperations() {
    const now = Date.now();
    for (const [id, operation] of wifiForgetOperations) {
        if (operation.expiresAt && operation.expiresAt <= now) {
            wifiForgetOperations.delete(id);
        }
    }
}

function cleanFirmwareUpdateOperations() {
    const now = Date.now();
    for (const [id, operation] of firmwareUpdateOperations) {
        if (operation.expiresAt && operation.expiresAt <= now) {
            firmwareUpdateOperations.delete(id);
        }
    }
}

function publicWifiConfiguration(operation) {
    return {
        requestId: operation.id,
        state: operation.state,
        message: operation.message,
        ssid: operation.ssid,
        ip: operation.ip || "",
        createdAt: operation.createdAt,
        updatedAt: operation.updatedAt
    };
}

function finishWifiConfiguration(operation, state, message, details = {}) {
    operation.state = state;
    operation.message = message;
    operation.updatedAt = new Date().toISOString();
    Object.assign(operation, details);

    if (["authenticated", "failed", "timed_out"].includes(state)) {
        clearTimeout(operation.timeout);
        operation.expiresAt = Date.now() + WIFI_CONFIGURATION_RETENTION_MS;
        if (activeWifiConfigurationId === operation.id) {
            activeWifiConfigurationId = null;
        }
    }
}

function updateWifiConfigurationFromDevice(ws, data) {
    if (
        !isRequestId(data.requestId) ||
        typeof data.state !== "string" ||
        !["accepted", "connecting", "wifi_connected", "authenticated", "failed"].includes(data.state)
    ) {
        return;
    }

    const operation = wifiConfigurationOperations.get(data.requestId);
    if (
        !operation ||
        activeWifiConfigurationId !== operation.id ||
        connectedDevice !== ws
    ) {
        return;
    }

    operation.device = ws;
    if (data.state === "failed") {
        finishWifiConfiguration(
            operation,
            "failed",
            "ESP32 could not connect to the requested Wi-Fi network. Its previous network remains saved.",
        );
        return;
    }

    const transitions = {
        command_sent: ["accepted"],
        accepted: ["connecting"],
        connecting: ["wifi_connected"],
        wifi_connected: ["authenticated"]
    };
    if (!transitions[operation.state]?.includes(data.state)) {
        return;
    }

    if (data.state === "authenticated") {
        const ssid = typeof data.ssid === "string" ? data.ssid : "";
        const ip = typeof data.ip === "string" ? data.ip : "";
        finishWifiConfiguration(
            operation,
            "authenticated",
            "Wi-Fi connected and ESP32 authenticated with the backend.",
            { ssid, ip }
        );
        return;
    }

    const messages = {
        accepted: "ESP32 accepted the Wi-Fi configuration.",
        connecting: "ESP32 is connecting to the requested Wi-Fi network.",
        wifi_connected: "Wi-Fi connected; waiting for the ESP32 to authenticate with the backend."
    };
    operation.state = data.state;
    operation.message = messages[data.state];
    operation.updatedAt = new Date().toISOString();
}

function publicWifiForget(operation) {
    return {
        requestId: operation.id,
        state: operation.state,
        message: operation.message,
        createdAt: operation.createdAt,
        updatedAt: operation.updatedAt
    };
}

function finishWifiForget(operation, state, message) {
    operation.state = state;
    operation.message = message;
    operation.updatedAt = new Date().toISOString();
    if (["deleted", "failed", "timed_out"].includes(state)) {
        clearTimeout(operation.timeout);
        operation.expiresAt = Date.now() + WIFI_CONFIGURATION_RETENTION_MS;
        if (activeWifiForgetId === operation.id) {
            activeWifiForgetId = null;
        }
    }
}

function updateWifiForgetFromDevice(ws, data) {
    if (
        !isRequestId(data.requestId) ||
        !["accepted", "deleted", "failed"].includes(data.state)
    ) {
        return;
    }

    const operation = wifiForgetOperations.get(data.requestId);
    if (
        !operation ||
        activeWifiForgetId !== operation.id ||
        connectedDevice !== ws
    ) {
        return;
    }

    if (data.state === "accepted" && operation.state === "command_sent") {
        operation.state = "accepted";
        operation.message = "ESP32 accepted the credential deletion request.";
        operation.updatedAt = new Date().toISOString();
    } else if (data.state === "deleted" && operation.state === "accepted") {
        finishWifiForget(
            operation,
            "deleted",
            "ESP32 confirmed that saved Wi-Fi credentials were deleted."
        );
    } else if (data.state === "failed") {
        finishWifiForget(
            operation,
            "failed",
            "ESP32 could not delete the saved Wi-Fi credentials."
        );
    }
}

function publicFirmwareUpdate(operation) {
    return {
        requestId: operation.id,
        state: operation.state,
        message: operation.message,
        version: operation.version || "",
        createdAt: operation.createdAt,
        updatedAt: operation.updatedAt
    };
}

function finishFirmwareUpdate(operation, state, message, version = operation.version) {
    operation.state = state;
    operation.message = message;
    operation.version = version || "";
    operation.updatedAt = new Date().toISOString();
    if (["verified", "available", "up_to_date", "failed", "timed_out"].includes(state)) {
        clearTimeout(operation.timeout);
        operation.expiresAt = Date.now() + WIFI_CONFIGURATION_RETENTION_MS;
        if (activeFirmwareUpdateId === operation.id) {
            activeFirmwareUpdateId = null;
        }
    }
}

function updateFirmwareUpdateFromDevice(ws, data) {
    const allowedStates = [
        "checking",
        "available",
        "downloading",
        "verifying",
        "rebooting",
        "up_to_date",
        "failed"
    ];
    if (
        !isRequestId(data.requestId) ||
        !allowedStates.includes(data.state) ||
        (data.version !== undefined &&
            (typeof data.version !== "string" || data.version.length > 32)) ||
        (data.message !== undefined &&
            (typeof data.message !== "string" || data.message.length > 240))
    ) {
        return;
    }

    const operation = firmwareUpdateOperations.get(data.requestId);
    if (
        !operation ||
        activeFirmwareUpdateId !== operation.id ||
        connectedDevice !== ws
    ) {
        return;
    }

    if (data.state === "failed") {
        finishFirmwareUpdate(
            operation,
            "failed",
            data.message || "ESP32 firmware update failed."
        );
        return;
    }
    if (data.state === "up_to_date") {
        finishFirmwareUpdate(
            operation,
            "up_to_date",
            "ESP32 already has the latest firmware.",
            data.version
        );
        return;
    }
    if (data.state === "available") {
        if (operation.kind !== "check" || operation.state !== "checking" || !data.version) {
            return;
        }
        finishFirmwareUpdate(
            operation,
            "available",
            "A newer signed stable firmware release is available.",
            data.version
        );
        return;
    }

    const transitions = {
        command_sent: ["checking"],
        checking: operation.kind === "check"
            ? []
            : ["downloading", "rebooting"],
        downloading: ["verifying"],
        verifying: ["rebooting"]
    };
    if (!transitions[operation.state]?.includes(data.state)) {
        return;
    }
    if (data.state === "rebooting" && !data.version) {
        return;
    }

    operation.state = data.state;
    operation.message = {
        checking: "Checking the signed GitHub firmware release.",
        downloading: "Downloading firmware over verified HTTPS.",
        verifying: "Verifying firmware hash and image before installation.",
        rebooting: "Firmware installed; waiting for the ESP32 to reconnect."
    }[data.state];
    operation.updatedAt = new Date().toISOString();
    if (data.state === "rebooting") {
        operation.version = data.version;
    }
}

function updateDeviceWifiStatus(data) {
    if (
        typeof data.connected !== "boolean" ||
        typeof data.ssid !== "string" ||
        typeof data.ip !== "string" ||
        (data.rssi !== undefined &&
            (!Number.isInteger(data.rssi) || data.rssi < -127 || data.rssi > 0)) ||
        (data.firmwareVersion !== undefined &&
            (typeof data.firmwareVersion !== "string" ||
                data.firmwareVersion.length > 32)) ||
        Buffer.byteLength(data.ssid, "utf8") > 32 ||
        data.ip.length > 45
    ) {
        return;
    }

    const connected = data.connected && Boolean(data.ssid && data.ip);
    const changedConnection =
        connected &&
        (!deviceWifiStatus.connected ||
            deviceWifiStatus.ssid !== data.ssid ||
            deviceWifiStatus.ip !== data.ip);

    deviceWifiStatus = {
        connected,
        ssid: connected ? data.ssid : "",
        ip: connected ? data.ip : "",
        rssi: connected && Number.isInteger(data.rssi) ? data.rssi : null,
        firmwareVersion: typeof data.firmwareVersion === "string"
            ? data.firmwareVersion
            : deviceWifiStatus.firmwareVersion,
        lastConnectedAt: changedConnection
            ? new Date().toISOString()
            : deviceWifiStatus.lastConnectedAt
    };

    const firmwareOperation =
        firmwareUpdateOperations.get(activeFirmwareUpdateId);
    if (
        firmwareOperation?.state === "rebooting" &&
        typeof data.firmwareVersion === "string" &&
        data.firmwareVersion === firmwareOperation.version
    ) {
        finishFirmwareUpdate(
            firmwareOperation,
            "verified",
            "ESP32 reconnected and reported the updated firmware version.",
            data.firmwareVersion
        );
    }
}

function settlePendingNotice(requestId, error, acknowledgement) {
    const pending = pendingNotices.get(requestId);
    if (!pending) return;

    clearTimeout(pending.timeout);
    pendingNotices.delete(requestId);

    if (error) {
        pending.reject(error);
        return;
    }

    latestNotice = pending.notice;
    pending.resolve(acknowledgement);
}

wss.on("connection", (ws) => {
    console.log("WebSocket connection received. Waiting for authentication.");

    ws.authenticated = false;
    ws.isAlive = true;

    const authTimeout = setTimeout(() => {
        if (!ws.authenticated) {
            ws.close(1008, "Authentication timeout");
        }
    }, 5000);

    ws.on("message", (message) => {
        let data;

        try {
            data = JSON.parse(message.toString());
        } catch {
            ws.close(1008, "Invalid JSON");
            return;
        }

        if (typeof data !== "object" || data === null || Array.isArray(data)) {
            ws.close(1008, "Invalid message");
            return;
        }

        // Authenticate ESP32
        if (!ws.authenticated) {
            if (
                data.type !== "AUTH" ||
                !verifyToken(data.token, DEVICE_TOKEN)
            ) {
                ws.close(1008, "Authentication failed");
                return;
            }

            clearTimeout(authTimeout);

            // Replace any previous device connection
            if (connectedDevice && connectedDevice !== ws) {
                connectedDevice.close(1000, "Replaced by new connection");
            }

            ws.authenticated = true;
            connectedDevice = ws;
            lastDeviceCommunicationAt = new Date().toISOString();

            console.log("ESP32 authenticated and connected.");

            ws.send(JSON.stringify({
                type: "CONNECTION",
                message: "ESP32 authenticated successfully"
            }));

            // Send latest notice after reconnecting
            if (latestNotice) {
                ws.send(JSON.stringify(latestNotice));
            }

            return;
        }

        lastDeviceCommunicationAt = new Date().toISOString();
        console.log("Message received from ESP32:", data.type || "unknown");

        if (data.type === "DEVICE_STATUS") {
            updateDeviceWifiStatus(data);
        } else if (data.type === "WIFI_CONFIG_STATUS") {
            updateWifiConfigurationFromDevice(ws, data);
        } else if (data.type === "WIFI_FORGET_STATUS") {
            updateWifiForgetFromDevice(ws, data);
        } else if (data.type === "FIRMWARE_UPDATE_STATUS") {
            updateFirmwareUpdateFromDevice(ws, data);
        } else if (data.type === "NOTICE_ACK" && typeof data.id === "string") {
            const pending = pendingNotices.get(data.id);
            if (pending && pending.device === ws) {
                if (data.success === true) {
                    settlePendingNotice(data.id, null, data);
                } else {
                    const error = new Error(
                        typeof data.message === "string"
                            ? data.message
                            : "ESP32 rejected the notice."
                    );
                    error.statusCode = 502;
                    settlePendingNotice(data.id, error);
                }
            }
        } else if (data.type === "PONG") {
            return;
        } else {
            ws.close(1008, "Unknown message type");
        }
    });

    ws.on("ping", () => {
        if (ws.authenticated && connectedDevice === ws) {
            lastDeviceCommunicationAt = new Date().toISOString();
        }
    });

    ws.on("pong", () => {
        ws.isAlive = true;

        if (ws.authenticated && connectedDevice === ws) {
            lastDeviceCommunicationAt = new Date().toISOString();
        }
    });

    ws.on("close", () => {
        clearTimeout(authTimeout);

        if (connectedDevice === ws) {
            connectedDevice = null;
            deviceWifiStatus.connected = false;
            deviceWifiStatus.ssid = "";
            deviceWifiStatus.ip = "";
            deviceWifiStatus.rssi = null;
            console.log("ESP32 disconnected.");
        }
        if (
            activeWifiConfigurationId &&
            ["command_sent", "accepted"].includes(
                wifiConfigurationOperations.get(activeWifiConfigurationId)?.state
            )
        ) {
            const operation = wifiConfigurationOperations.get(activeWifiConfigurationId);
            if (operation?.device === ws) {
                finishWifiConfiguration(
                    operation,
                    "failed",
                    "ESP32 disconnected before starting the Wi-Fi connection."
                );
            }
        }
        if (
            activeWifiForgetId &&
            ["command_sent", "accepted"].includes(
                wifiForgetOperations.get(activeWifiForgetId)?.state
            )
        ) {
            const operation = wifiForgetOperations.get(activeWifiForgetId);
            if (operation?.device === ws) {
                finishWifiForget(
                    operation,
                    "timed_out",
                    "ESP32 disconnected before confirming Wi-Fi credential deletion."
                );
            }
        }
        if (
            activeFirmwareUpdateId &&
            firmwareUpdateOperations.get(activeFirmwareUpdateId)?.state !==
            "rebooting"
        ) {
            const operation = firmwareUpdateOperations.get(activeFirmwareUpdateId);
            if (operation?.device === ws) {
                finishFirmwareUpdate(
                    operation,
                    "failed",
                    "ESP32 disconnected before firmware installation completed."
                );
            }
        }
        for (const [requestId, pending] of pendingNotices) {
            if (pending.device === ws) {
                const error = new Error("ESP32 disconnected before acknowledging the notice.");
                error.statusCode = 503;
                settlePendingNotice(requestId, error);
            }
        }
    });

    ws.on("error", (error) => {
        console.error("WebSocket error:", error.message);
    });
});

// Send notice from dashboard
app.post(
    "/api/notices",
    authenticateDashboard,
    async (req, res) => {
        const notice = req.body?.notice;

        if (
            typeof notice !== "string" ||
            !notice.trim() ||
            notice.trim().length > MAX_NOTICE_LENGTH
        ) {
            return res.status(400).json({
                success: false,
                message: "Notice must contain 1 to 200 characters."
            });
        }

        if (!connectedDevice ||
            connectedDevice.readyState !== WebSocket.OPEN) {
            return res.status(503).json({
                success: false,
                delivered: false,
                message: "ESP32 is not connected."
            });
        }

        const device = connectedDevice;
        const requestId = crypto.randomUUID();
        const noticeRecord = {
            notice: notice.trim(),
            sentAt: new Date().toISOString()
        };
        const noticeMessage = {
            type: "NOTICE",
            id: requestId,
            ...noticeRecord
        };

        try {
            await new Promise((resolve, reject) => {
                const timeout = setTimeout(() => {
                    const error = new Error("ESP32 did not acknowledge the notice in time.");
                    error.statusCode = 504;
                    settlePendingNotice(requestId, error);
                }, NOTICE_ACK_TIMEOUT_MS);
                pendingNotices.set(requestId, {
                    device,
                    notice: noticeMessage,
                    resolve,
                    reject,
                    timeout
                });

                try {
                    device.send(JSON.stringify(noticeMessage), (error) => {
                        if (error) {
                            error.statusCode = 503;
                            settlePendingNotice(requestId, error);
                        }
                    });
                } catch (error) {
                    error.statusCode = 503;
                    settlePendingNotice(requestId, error);
                }
            });

            return res.json({
                success: true,
                delivered: true,
                requestId,
                ...noticeRecord,
                message: "ESP32 acknowledged the notice command. You can see the physical LCD output to verify."
            });
        } catch (error) {
            console.error("Notice delivery failed:", error.message);
            if (!res.headersSent) {
                return res.status(error.statusCode || 503).json({
                    success: false,
                    delivered: false,
                    message: error.message
                });
            }
        }
    }
);

app.post(
    "/api/device/wifi-config",
    authenticateDashboard,
    (req, res) => {
        cleanWifiConfigurationOperations();
        cleanWifiForgetOperations();
        const ssid = typeof req.body?.ssid === "string"
            ? req.body.ssid.trim()
            : "";
        const password = req.body?.password;

        if (
            !ssid ||
            Buffer.byteLength(ssid, "utf8") > 32
        ) {
            return res.status(400).json({
                success: false,
                message: "Wi-Fi SSID must contain 1 to 32 UTF-8 bytes."
            });
        }

        if (
            typeof password !== "string" ||
            (password.length > 0 &&
                (Buffer.byteLength(password, "utf8") < 8 ||
                    Buffer.byteLength(password, "utf8") > 63))
        ) {
            return res.status(400).json({
                success: false,
                message: "Wi-Fi password must be 8 to 63 UTF-8 bytes, or empty for an open network."
            });
        }

        if (
            !connectedDevice ||
            connectedDevice.readyState !== WebSocket.OPEN ||
            !connectedDevice.authenticated
        ) {
            return res.status(503).json({
                success: false,
                message: "ESP32 is not connected to the backend."
            });
        }

        if (
            activeWifiConfigurationId ||
            activeWifiForgetId ||
            activeFirmwareUpdateId
        ) {
            const activeOperation = wifiConfigurationOperations.get(activeWifiConfigurationId);
            if (
                activeWifiForgetId ||
                activeFirmwareUpdateId ||
                (activeOperation && !activeOperation.expiresAt)
            ) {
                return res.status(409).json({
                    success: false,
                    message: "A Wi-Fi configuration operation is already in progress."
                });
            }
        }

        const requestId = crypto.randomUUID();
        const operation = {
            id: requestId,
            state: "command_sent",
            message: "Wi-Fi configuration command sent to ESP32.",
            ssid,
            ip: "",
            device: connectedDevice,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            expiresAt: null,
            timeout: null
        };
        operation.timeout = setTimeout(() => {
            const message = operation.state === "connecting" ||
                operation.state === "wifi_connected"
                ? "ESP32 did not confirm backend reconnection. Wi-Fi may have connected; verify the device using its recovery access point."
                : "ESP32 did not complete the Wi-Fi configuration.";
            finishWifiConfiguration(operation, "timed_out", message);
        }, WIFI_CONFIGURATION_TIMEOUT_MS);
        wifiConfigurationOperations.set(requestId, operation);
        activeWifiConfigurationId = requestId;

        try {
            connectedDevice.send(JSON.stringify({
                type: "WIFI_CONFIG",
                requestId,
                ssid,
                password
            }), (error) => {
                if (error) {
                    finishWifiConfiguration(
                        operation,
                        "failed",
                        "The Wi-Fi configuration command could not be sent to the ESP32."
                    );
                }
            });
        } catch {
            finishWifiConfiguration(
                operation,
                "failed",
                "The Wi-Fi configuration command could not be sent to the ESP32."
            );
        }

        return res.status(202).json({
            success: true,
            requestId,
            state: operation.state,
            message: operation.message
        });
    }
);

app.get(
    "/api/device/wifi-config/:requestId",
    authenticateDashboard,
    (req, res) => {
        if (!isRequestId(req.params.requestId)) {
            return res.status(400).json({
                success: false,
                message: "Invalid Wi-Fi configuration request ID."
            });
        }

        cleanWifiConfigurationOperations();
        const operation = wifiConfigurationOperations.get(req.params.requestId);
        if (!operation) {
            return res.status(404).json({
                success: false,
                message: "Wi-Fi configuration request was not found or has expired."
            });
        }

        return res.json({
            success: true,
            operation: publicWifiConfiguration(operation)
        });
    }
);

app.post(
    "/api/device/wifi-forget",
    authenticateDashboard,
    (req, res) => {
        cleanWifiConfigurationOperations();
        cleanWifiForgetOperations();
        if (
            !connectedDevice ||
            connectedDevice.readyState !== WebSocket.OPEN ||
            !connectedDevice.authenticated
        ) {
            return res.status(503).json({
                success: false,
                message: "ESP32 is not connected to the backend."
            });
        }

        const activeConfiguration = wifiConfigurationOperations.get(
            activeWifiConfigurationId
        );
        if (
            (activeConfiguration && !activeConfiguration.expiresAt) ||
            activeWifiForgetId ||
            activeFirmwareUpdateId
        ) {
            return res.status(409).json({
                success: false,
                message: "Another Wi-Fi operation is already in progress."
            });
        }

        const requestId = crypto.randomUUID();
        const operation = {
            id: requestId,
            state: "command_sent",
            message: "Wi-Fi credential deletion command sent to ESP32.",
            device: connectedDevice,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            expiresAt: null,
            timeout: null
        };
        operation.timeout = setTimeout(() => {
            finishWifiForget(
                operation,
                "timed_out",
                "ESP32 did not confirm Wi-Fi credential deletion."
            );
        }, WIFI_FORGET_TIMEOUT_MS);
        wifiForgetOperations.set(requestId, operation);
        activeWifiForgetId = requestId;

        try {
            connectedDevice.send(JSON.stringify({
                type: "WIFI_FORGET",
                requestId
            }), (error) => {
                if (error) {
                    finishWifiForget(
                        operation,
                        "failed",
                        "The Wi-Fi deletion command could not be sent to the ESP32."
                    );
                }
            });
        } catch {
            finishWifiForget(
                operation,
                "failed",
                "The Wi-Fi deletion command could not be sent to the ESP32."
            );
        }

        return res.status(202).json({
            success: true,
            requestId,
            state: operation.state,
            message: operation.message
        });
    }
);

app.get(
    "/api/device/wifi-forget/:requestId",
    authenticateDashboard,
    (req, res) => {
        if (!isRequestId(req.params.requestId)) {
            return res.status(400).json({
                success: false,
                message: "Invalid Wi-Fi forget request ID."
            });
        }

        cleanWifiConfigurationOperations();
        cleanWifiForgetOperations();
        const operation = wifiForgetOperations.get(req.params.requestId);
        if (!operation || (operation.expiresAt && operation.expiresAt <= Date.now())) {
            wifiForgetOperations.delete(req.params.requestId);
            return res.status(404).json({
                success: false,
                message: "Wi-Fi forget request was not found or has expired."
            });
        }

        return res.json({
            success: true,
            operation: publicWifiForget(operation)
        });
    }
);

function startFirmwareOperation(kind, allowReinstall, res) {
    cleanWifiConfigurationOperations();
    cleanWifiForgetOperations();
    cleanFirmwareUpdateOperations();

    if (
        !connectedDevice ||
        connectedDevice.readyState !== WebSocket.OPEN ||
        !connectedDevice.authenticated
    ) {
        return res.status(503).json({
            success: false,
            message: "ESP32 is not connected to the backend."
        });
    }

    const activeConfiguration = wifiConfigurationOperations.get(
        activeWifiConfigurationId
    );
    const activeForget = wifiForgetOperations.get(activeWifiForgetId);
    if (
        (activeConfiguration && !activeConfiguration.expiresAt) ||
        (activeForget && !activeForget.expiresAt) ||
        activeFirmwareUpdateId
    ) {
        return res.status(409).json({
            success: false,
            message: "Another device operation is already in progress."
        });
    }

    const requestId = crypto.randomUUID();
    const operation = {
        id: requestId,
        kind,
        allowReinstall,
        state: "command_sent",
        message: kind === "check"
            ? "Firmware release check sent to ESP32."
            : "Firmware installation request sent to ESP32.",
        version: "",
        device: connectedDevice,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        expiresAt: null,
        timeout: null
    };
    operation.timeout = setTimeout(() => {
        finishFirmwareUpdate(
            operation,
            "timed_out",
            kind === "check"
                ? "ESP32 did not complete the stable release check."
                : "ESP32 did not confirm firmware installation and reconnection."
        );
    }, kind === "check" ? FIRMWARE_CHECK_TIMEOUT_MS : FIRMWARE_UPDATE_TIMEOUT_MS);
    firmwareUpdateOperations.set(requestId, operation);
    activeFirmwareUpdateId = requestId;

    const command = {
        type: kind === "check" ? "FIRMWARE_CHECK" : "FIRMWARE_UPDATE",
        requestId
    };
    if (kind === "update") command.allowReinstall = allowReinstall;

    try {
        connectedDevice.send(JSON.stringify(command), (error) => {
            if (error) {
                finishFirmwareUpdate(
                    operation,
                    "failed",
                    "The firmware operation command could not be sent to the ESP32."
                );
            }
        });
    } catch {
        finishFirmwareUpdate(
            operation,
            "failed",
            "The firmware operation command could not be sent to the ESP32."
        );
    }

    return res.status(202).json({
        success: true,
        requestId,
        state: operation.state,
        message: operation.message
    });
}

app.post(
    "/api/device/firmware-check",
    authenticateDashboard,
    (_req, res) => startFirmwareOperation("check", false, res)
);

app.post(
    "/api/device/firmware-update",
    authenticateDashboard,
    (req, res) => {
        if (
            req.body?.allowReinstall !== undefined &&
            typeof req.body.allowReinstall !== "boolean"
        ) {
            return res.status(400).json({
                success: false,
                message: "allowReinstall must be a boolean."
            });
        }
        return startFirmwareOperation(
            "update",
            req.body?.allowReinstall === true,
            res
        );
    }
);

app.get(
    "/api/device/firmware-update/:requestId",
    authenticateDashboard,
    (req, res) => {
        if (!isRequestId(req.params.requestId)) {
            return res.status(400).json({
                success: false,
                message: "Invalid firmware update request ID."
            });
        }

        cleanFirmwareUpdateOperations();
        const operation = firmwareUpdateOperations.get(req.params.requestId);
        if (!operation) {
            return res.status(404).json({
                success: false,
                message: "Firmware update request was not found or has expired."
            });
        }

        return res.json({
            success: true,
            operation: publicFirmwareUpdate(operation)
        });
    }
);

// Device connection status
app.get(
    "/api/device/status",
    authenticateDashboard,
    (req, res) => {
        res.json({
            connected: Boolean(
                connectedDevice &&
                connectedDevice.readyState === WebSocket.OPEN
            ),
            websocketConnected: Boolean(
                connectedDevice &&
                connectedDevice.readyState === WebSocket.OPEN
            ),
            lastSeenAt: lastDeviceCommunicationAt,
            wifi: deviceWifiStatus,
            latestNotice
        });
    }
);

app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    if (error.type === "entity.parse.failed") {
        return res.status(400).json({
            success: false,
            message: "Request body must contain valid JSON."
        });
    }
    console.error("Unhandled request error:", error.message);
    return res.status(500).json({
        success: false,
        message: "The backend could not process the request."
    });
});

if (require.main === module) {
    server.listen(PORT, "0.0.0.0", () => {
        console.log(`Smart Notice Board Backend running on port ${PORT}`);
    });
}

module.exports = { app, server, wss };
