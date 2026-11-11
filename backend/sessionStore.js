const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

function createSessionStore(filePath) {
    const absolutePath = path.resolve(filePath);
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true });

    let sessions = new Map();
    if (fs.existsSync(absolutePath)) {
        const parsed = JSON.parse(fs.readFileSync(absolutePath, "utf8"));
        if (
            parsed?.version !== 1 ||
            !Array.isArray(parsed.sessions) ||
            parsed.sessions.some((entry) =>
                !Array.isArray(entry) ||
                entry.length !== 2 ||
                typeof entry[0] !== "string" ||
                !/^[a-f0-9]{64}$/.test(entry[0]) ||
                !Number.isSafeInteger(entry[1])
            )
        ) {
            throw new Error("Dashboard session store is corrupt or unsupported.");
        }
        sessions = new Map(parsed.sessions);
    }

    function persist() {
        const temporaryPath = `${absolutePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
        try {
            fs.writeFileSync(
                temporaryPath,
                JSON.stringify({ version: 1, sessions: [...sessions] }),
                { encoding: "utf8", mode: 0o600 }
            );
            fs.renameSync(temporaryPath, absolutePath);
        } finally {
            if (fs.existsSync(temporaryPath)) fs.unlinkSync(temporaryPath);
        }
    }

    return {
        get(sessionKey) {
            return sessions.get(sessionKey);
        },
        set(sessionKey, expiresAt) {
            sessions.set(sessionKey, expiresAt);
            persist();
        },
        delete(sessionKey) {
            if (!sessions.delete(sessionKey)) return false;
            persist();
            return true;
        },
        pruneExpired(now = Date.now()) {
            let changed = false;
            for (const [sessionKey, expiresAt] of sessions) {
                if (expiresAt <= now) {
                    sessions.delete(sessionKey);
                    changed = true;
                }
            }
            if (changed) persist();
        }
    };
}

module.exports = { createSessionStore };
