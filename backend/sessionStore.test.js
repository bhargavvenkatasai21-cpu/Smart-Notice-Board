const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { after, test } = require("node:test");
const { createSessionStore } = require("./sessionStore");

const temporaryDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), "smart-notice-session-store-")
);
after(() => fs.rmSync(temporaryDirectory, { recursive: true, force: true }));

test("dashboard sessions persist across store recreation and can be revoked", () => {
    const filePath = path.join(temporaryDirectory, "sessions.json");
    const key = crypto.createHash("sha256").update("test-session").digest("hex");
    const store = createSessionStore(filePath);
    store.set(key, 123456789);

    const restartedStore = createSessionStore(filePath);
    assert.equal(restartedStore.get(key), 123456789);
    assert.equal(restartedStore.delete(key), true);
    assert.equal(createSessionStore(filePath).get(key), undefined);
});

test("expired dashboard sessions are pruned from persistent storage", () => {
    const filePath = path.join(temporaryDirectory, "expiry.json");
    const store = createSessionStore(filePath);
    const expiredKey = crypto.createHash("sha256").update("expired").digest("hex");
    const validKey = crypto.createHash("sha256").update("valid").digest("hex");
    store.set(expiredKey, 99);
    store.set(validKey, 101);

    store.pruneExpired(100);

    const restartedStore = createSessionStore(filePath);
    assert.equal(restartedStore.get(expiredKey), undefined);
    assert.equal(restartedStore.get(validKey), 101);
});
