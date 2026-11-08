
const express = require("express");
const cors = require("cors");
const http = require("http");
const crypto = require("crypto");
const WebSocket = require("ws");
require("dotenv").config();

const app = express();
const server = http.createServer(app);

const PORT = process.env.PORT || 5000;
const DEVICE_TOKEN = process.env.ESP32_DEVICE_TOKEN;
const DASHBOARD_ACCESS_CODE = process.env.DASHBOARD_ACCESS_CODE;
const MAX_NOTICE_LENGTH = 200;
const NOTICE_ACK_TIMEOUT_MS = Number(process.env.NOTICE_ACK_TIMEOUT_MS) || 10000;
const DASHBOARD_SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const REMEMBERED_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const DASHBOARD_ORIGINS = (process.env.DASHBOARD_ORIGIN || "http://localhost:5173")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);

if (!DEVICE_TOKEN || !DASHBOARD_ACCESS_CODE) {
    throw new Error("Missing ESP32_DEVICE_TOKEN or DASHBOARD_ACCESS_CODE in .env");
}

app.use(cors({
    origin: DASHBOARD_ORIGINS,
    methods: ["GET", "POST"],
    allowedHeaders: ["Content-Type", "Authorization"]
}));

app.use(express.json({ limit: "10kb" }));

// Compare tokens safely
function verifyToken(provided, expected) {
    if (typeof provided !== "string") return false;

    const a = Buffer.from(provided);
    const b = Buffer.from(expected);

    return a.length === b.length &&
        crypto.timingSafeEqual(a, b);
}

const dashboardSessions = new Map();

function hashSessionToken(token) {
    return crypto.createHash("sha256").update(token).digest("hex");
}

function createDashboardSession(rememberMe) {
    const sessionToken = crypto.randomBytes(32).toString("hex");
    const now = Date.now();
    for (const [sessionKey, sessionExpiry] of dashboardSessions) {
        if (sessionExpiry <= now) dashboardSessions.delete(sessionKey);
    }
    const expiresAt = now +
        (rememberMe ? REMEMBERED_SESSION_TTL_MS : DASHBOARD_SESSION_TTL_MS);
    dashboardSessions.set(hashSessionToken(sessionToken), expiresAt);
    return { sessionToken, expiresAt: new Date(expiresAt).toISOString() };
}

// Dashboard authentication
function authenticateDashboard(req, res, next) {
    const authorization = req.headers.authorization || "";
    const sessionToken = authorization.startsWith("Bearer ")
        ? authorization.slice(7)
        : "";
    const sessionKey = sessionToken ? hashSessionToken(sessionToken) : "";
    const expiresAt = dashboardSessions.get(sessionKey);

    if (!expiresAt || expiresAt <= Date.now()) {
        if (sessionKey) dashboardSessions.delete(sessionKey);
        return res.status(401).json({
            success: false,
            message: "Dashboard session is invalid or expired."
        });
    }

    req.dashboardSessionKey = sessionKey;
    next();
}

app.post("/api/auth/login", (req, res) => {
    const accessCode = req.body?.accessCode;
    if (typeof accessCode !== "string" || !accessCode.trim()) {
        return res.status(400).json({
            success: false,
            message: "Enter the dashboard access code."
        });
    }

    if (!verifyToken(accessCode, DASHBOARD_ACCESS_CODE)) {
        return res.status(401).json({
            success: false,
            message: "Incorrect dashboard access code."
        });
    }

    const session = createDashboardSession(req.body?.rememberMe === true);
    return res.json({ success: true, ...session });
});

app.post("/api/auth/logout", authenticateDashboard, (req, res) => {
    dashboardSessions.delete(req.dashboardSessionKey);
    return res.json({ success: true });
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

let connectedDevice = null;
let latestNotice = null;
let lastDeviceCommunicationAt = null;
const pendingNotices = new Map();

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
        console.log("Message received from ESP32:", data);

        if (data.type === "NOTICE_ACK" && typeof data.id === "string") {
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
        }
    });

    ws.on("ping", () => {
        if (ws.authenticated && connectedDevice === ws) {
            lastDeviceCommunicationAt = new Date().toISOString();
        }
    });

    ws.on("pong", () => {
        if (ws.authenticated && connectedDevice === ws) {
            lastDeviceCommunicationAt = new Date().toISOString();
        }
    });

    ws.on("close", () => {
        clearTimeout(authTimeout);

        if (connectedDevice === ws) {
            connectedDevice = null;
            console.log("ESP32 disconnected.");
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
                message: "ESP32 acknowledged the notice command. Physical LCD output cannot be verified remotely."
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
