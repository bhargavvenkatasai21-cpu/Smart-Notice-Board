#include <Arduino.h>
#include <ArduinoJson.h>
#include <LiquidCrystal.h>
#include <Preferences.h>
#include <WebServer.h>
#include <WiFi.h>

namespace {
constexpr char kApName[] = "SmartNoticeBoard";
constexpr char kApPassword[] = "12345678";
constexpr char kPreferencesNamespace[] = "wifi";

constexpr unsigned long kReconnectIntervalMs = 10000;
constexpr unsigned long kConnectionTimeoutMs = 30000;
constexpr unsigned long kInitialFrameHoldMs = 5000;
constexpr unsigned long kScrollIntervalMs = 350;

constexpr size_t kMaxNoticeLength = 200;
constexpr size_t kLcdColumns = 16;
constexpr size_t kFirstSegmentColumns = 8;

// ESP32 pins: RS, E, DB4, DB5, DB6, DB7
LiquidCrystal lcd(23, 22, 21, 19, 18, 17);
WebServer server(80);
Preferences preferences;

String notice;
bool noticeActive = false;
size_t scrollPosition = 0;
unsigned long lastScrollTime = 0;

bool connectionInProgress = false;
bool reconnectEnabled = true;
bool connectionSawDisconnect = true;
unsigned long connectionStartedAt = 0;
unsigned long lastReconnectAttemptAt = 0;
String connectionTargetSsid;
String connectionError;

enum class CredentialLoadResult {
    Loaded,
    Missing,
    StorageError,
};

bool connectedToTargetNetwork() {
    return (!connectionInProgress || connectionSawDisconnect) &&
           WiFi.status() == WL_CONNECTED &&
           !connectionTargetSsid.isEmpty() &&
           WiFi.SSID() == connectionTargetSsid;
}

// JHD161A is physically one row of 16 characters. Internally, its
// controller uses two 8-character DDRAM address sections. The LiquidCrystal
// library's row 0 and row 1 addresses select those two visible sections.
void writeLcd16(const String &text) {
    char frame[kLcdColumns + 1];
    for (size_t i = 0; i < kLcdColumns; ++i) {
        frame[i] = (i < text.length()) ? text[i] : ' ';
    }
    frame[kLcdColumns] = '\0';

    lcd.setCursor(0, 0);
    for (size_t i = 0; i < kFirstSegmentColumns; ++i) {
        lcd.write(static_cast<uint8_t>(frame[i]));
    }

    lcd.setCursor(0, 1);
    for (size_t i = kFirstSegmentColumns; i < kLcdColumns; ++i) {
        lcd.write(static_cast<uint8_t>(frame[i]));
    }
}

void displayNoticeFrame() {
    String frame;
    frame.reserve(kLcdColumns);

    for (size_t column = 0; column < kLcdColumns; ++column) {
        const size_t characterIndex = scrollPosition + column;
        frame += (characterIndex < notice.length())
                     ? notice[characterIndex]
                     : ' ';
    }
    writeLcd16(frame);
}

void updateNoticeScroll() {
    if (!noticeActive || notice.length() <= kLcdColumns) {
        return;
    }

    const unsigned long now = millis();
    const unsigned long interval =
        (scrollPosition == 0) ? kInitialFrameHoldMs : kScrollIntervalMs;

    if (now - lastScrollTime < interval) {
        return;
    }

    lastScrollTime = now;
    ++scrollPosition;

    // Show the trailing blank frame, then restart at the first character.
    if (scrollPosition > notice.length()) {
        scrollPosition = 0;
    }

    displayNoticeFrame();
}

void addCorsHeaders() {
    server.sendHeader("Access-Control-Allow-Origin", "*");
    server.sendHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    server.sendHeader("Access-Control-Allow-Headers", "Content-Type");
}

void sendJson(int statusCode, JsonDocument &document) {
    String body;
    serializeJson(document, body);
    addCorsHeaders();
    server.send(statusCode, "application/json", body);
}

void sendMessage(int statusCode, const char *message) {
    JsonDocument document;
    document["message"] = message;
    sendJson(statusCode, document);
}

void handleOptions() {
    addCorsHeaders();
    server.send(204);
}

CredentialLoadResult loadSavedCredentials(String &ssid, String &password) {
    if (!preferences.begin(kPreferencesNamespace, true)) {
        Serial.println("ERROR: Could not open WiFi preferences");
        return CredentialLoadResult::StorageError;
    }

    ssid = preferences.getString("ssid", "");
    password = preferences.getString("password", "");
    preferences.end();
    return ssid.isEmpty()
               ? CredentialLoadResult::Missing
               : CredentialLoadResult::Loaded;
}

void beginConnection(const String &ssid, const String &password) {
    const bool wasConnected = WiFi.status() == WL_CONNECTED;

    reconnectEnabled = true;
    connectionInProgress = true;
    connectionStartedAt = millis();
    lastReconnectAttemptAt = connectionStartedAt;
    connectionTargetSsid = ssid;
    connectionError = "";

    // Cancel any previous station attempt so an old connection cannot be
    // mistaken for success while the requested network is still connecting.
    WiFi.setAutoReconnect(false);
    WiFi.disconnect(false, false);
    connectionSawDisconnect = !wasConnected || WiFi.status() != WL_CONNECTED;
    WiFi.setAutoReconnect(true);
    WiFi.begin(ssid.c_str(), password.c_str());

    lcd.clear();
    writeLcd16("Connecting WiFi");
    Serial.printf("Connecting to WiFi network: %s\n", ssid.c_str());
}

void handleConnect() {
    if (connectionInProgress) {
        sendMessage(409, "A WiFi connection attempt is already in progress");
        return;
    }

    if (!server.hasArg("plain") || server.arg("plain").isEmpty()) {
        sendMessage(400, "WiFi name is required");
        return;
    }

    String ssid;
    String password;

    JsonDocument document;
    const DeserializationError error =
        deserializeJson(document, server.arg("plain"));

    if (error) {
        sendMessage(400, "Invalid JSON WiFi details");
        return;
    }

    ssid = document["ssid"] | "";
    password = document["password"] | "";
    String trimmedSsid = ssid;
    trimmedSsid.trim();

    if (trimmedSsid.isEmpty()) {
        sendMessage(400, "WiFi name is required");
        return;
    }

    if (ssid.length() > 32) {
        sendMessage(400, "WiFi name cannot exceed 32 bytes");
        return;
    }

    if (!password.isEmpty() &&
        (password.length() < 8 || password.length() > 63)) {
        sendMessage(400, "WiFi password must be 8 to 63 characters, or empty for an open network");
        return;
    }

    if (!preferences.begin(kPreferencesNamespace, false)) {
        Serial.println("ERROR: Could not open WiFi preferences for writing");
        sendMessage(500, "Could not save WiFi credentials");
        return;
    }

    preferences.putString("ssid", ssid);
    preferences.putString("password", password);
    const bool saved =
        preferences.getString("ssid", "") == ssid &&
        preferences.getString("password", "") == password;
    preferences.end();

    if (!saved) {
        Serial.println("ERROR: WiFi credentials could not be verified in preferences");
        sendMessage(500, "Could not save WiFi credentials");
        return;
    }

    beginConnection(ssid, password);
    sendMessage(202, "WiFi credentials saved; connection is in progress");
}

void handleReconnect() {
    if (connectionInProgress) {
        sendMessage(409, "A WiFi connection attempt is already in progress");
        return;
    }

    String ssid;
    String password;

    const CredentialLoadResult result =
        loadSavedCredentials(ssid, password);
    if (result == CredentialLoadResult::StorageError) {
        sendMessage(500, "Could not read saved WiFi credentials");
        return;
    }
    if (result == CredentialLoadResult::Missing) {
        sendMessage(400, "No saved WiFi network exists");
        return;
    }

    if (connectedToTargetNetwork() && WiFi.SSID() == ssid) {
        sendMessage(200, "Already connected to the saved WiFi network");
        return;
    }

    beginConnection(ssid, password);
    sendMessage(202, "Reconnecting to the saved WiFi network");
}

void handleDisconnect() {
    reconnectEnabled = false;
    connectionInProgress = false;
    connectionError = "";

    sendMessage(202, "Disconnecting from WiFi; saved credentials were kept");
    WiFi.setAutoReconnect(false);
    WiFi.disconnect(false, false);

    lcd.clear();
    writeLcd16("WiFi Disconnected");
}

void handleNotice() {
    if (!server.hasArg("plain") || server.arg("plain").isEmpty()) {
        sendMessage(400, "Notice text is required");
        return;
    }

    JsonDocument document;
    const DeserializationError error =
        deserializeJson(document, server.arg("plain"));

    if (error) {
        sendMessage(400, "Invalid JSON notice");
        return;
    }

    String newNotice = document["notice"] | "";
    newNotice.trim();

    if (newNotice.isEmpty()) {
        sendMessage(400, "Notice cannot be empty");
        return;
    }

    if (newNotice.length() > kMaxNoticeLength) {
        newNotice = newNotice.substring(0, kMaxNoticeLength);
    }

    notice = newNotice;
    scrollPosition = 0;
    lastScrollTime = millis();
    noticeActive = true;

    lcd.clear();
    lcd.noAutoscroll();
    lcd.leftToRight();
    lcd.noCursor();
    lcd.noBlink();
    displayNoticeFrame();

    Serial.println("New notice received:");
    Serial.println(notice);
    Serial.println("LCD notice display started at character 1");

    sendMessage(200, "Notice displayed on the LCD");
}

void handleRoot() {
    addCorsHeaders();
    server.send(200, "text/plain", "Smart Notice Board is online!");
    Serial.println("Root endpoint accessed");
}

void handleStatus() {
    JsonDocument document;
    const bool connected = connectedToTargetNetwork();

    document["connected"] = connected;
    document["connecting"] = connectionInProgress;
    document["ip"] = connected ? WiFi.localIP().toString() : "";
    document["ssid"] = connected ? WiFi.SSID() : "";
    document["apIp"] = WiFi.softAPIP().toString();
    document["connectionError"] = connectionError;
    sendJson(200, document);
}

void startAccessPoint() {
    const bool success = WiFi.softAP(kApName, kApPassword);
    if (!success) {
        Serial.println("ERROR: Failed to start setup access point");
        return;
    }

    Serial.println("Access point started");
    Serial.printf("AP name: %s\n", kApName);
    Serial.print("AP IP address: ");
    Serial.println(WiFi.softAPIP());
}

void setupServer() {
    server.on("/", HTTP_GET, handleRoot);

    server.on("/status", HTTP_GET, handleStatus);
    server.on("/status", HTTP_OPTIONS, handleOptions);

    server.on("/connect", HTTP_POST, handleConnect);
    server.on("/connect", HTTP_OPTIONS, handleOptions);

    server.on("/reconnect", HTTP_POST, handleReconnect);
    server.on("/reconnect", HTTP_OPTIONS, handleOptions);

    server.on("/disconnect", HTTP_POST, handleDisconnect);
    server.on("/disconnect", HTTP_OPTIONS, handleOptions);

    server.on("/notice", HTTP_POST, handleNotice);
    server.on("/notice", HTTP_OPTIONS, handleOptions);

    server.onNotFound([]() {
        addCorsHeaders();
        server.send(404, "application/json", "{\"message\":\"Not found\"}");
        Serial.println("Unknown HTTP endpoint requested");
    });

    server.begin();
    Serial.println("HTTP server started on port 80");
}

void updateConnectionState() {
    const unsigned long now = millis();
    if (WiFi.status() != WL_CONNECTED) {
        connectionSawDisconnect = true;
    }
    const bool connected = connectedToTargetNetwork();

    if (connected) {
        connectionError = "";
        if (connectionInProgress) {
            connectionInProgress = false;
            Serial.println("WiFi connected!");
            Serial.print("ESP32 IP address: ");
            Serial.println(WiFi.localIP());
            Serial.print("WiFi SSID: ");
            Serial.println(WiFi.SSID());

            lcd.clear();
            writeLcd16(WiFi.localIP().toString());
        }
        return;
    }

    if (connectionInProgress &&
        now - connectionStartedAt >= kConnectionTimeoutMs) {
        connectionInProgress = false;
        lastReconnectAttemptAt = now;
        connectionError =
            "WiFi connection timed out. Check the network name, password, and signal.";
        Serial.println("WiFi connection attempt timed out");
        WiFi.setAutoReconnect(false);
        WiFi.disconnect(false, false);
        connectionSawDisconnect = true;
        WiFi.setAutoReconnect(reconnectEnabled);
        lcd.clear();
        writeLcd16("WiFi Failed");
    }

    if (reconnectEnabled &&
        !connectionInProgress &&
        now - lastReconnectAttemptAt >= kReconnectIntervalMs) {
        String ssid;
        String password;

        if (loadSavedCredentials(ssid, password) ==
            CredentialLoadResult::Loaded) {
            beginConnection(ssid, password);
            Serial.println("Retrying saved WiFi connection");
        }
    }
}

} // namespace

void setup() {
    Serial.begin(115200);
    delay(500);

    Serial.println();
    Serial.println("Starting Smart Notice Board...");

    lcd.begin(16, 2);
    lcd.noAutoscroll();
    lcd.leftToRight();
    lcd.noCursor();
    lcd.noBlink();
    lcd.clear();
    writeLcd16("Starting Board");

    WiFi.mode(WIFI_AP_STA);
    WiFi.setAutoReconnect(true);

    startAccessPoint();
    setupServer();

    String savedSSID;
    String savedPassword;

    const CredentialLoadResult credentialResult =
        loadSavedCredentials(savedSSID, savedPassword);
    if (credentialResult == CredentialLoadResult::Loaded) {
        beginConnection(savedSSID, savedPassword);
    } else {
        lcd.clear();
        writeLcd16(credentialResult == CredentialLoadResult::StorageError
                       ? "WiFi Pref Error"
                       : "Setup Hotspot");
        Serial.println(
            credentialResult == CredentialLoadResult::StorageError
                ? "WiFi preferences are unavailable"
                : "Waiting for WiFi setup");
    }
}

void loop() {
    server.handleClient();
    updateConnectionState();
    updateNoticeScroll();
    delay(2);
}
