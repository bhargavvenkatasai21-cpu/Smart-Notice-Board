#include <Arduino.h>
#include <ArduinoJson.h>
#include <ctype.h>
#include <string.h>
#include <time.h>
#include <LiquidCrystal.h>
#include <Preferences.h>
#include <WebServer.h>
#include <WiFi.h>
#include <WebSocketsClient.h>
#include "secrets.h"
#include "ota_config.h"
#include "trust_roots.h"
#include "firmware_update.h"

namespace
{
    constexpr char kApName[] = "SmartNoticeBoard";
#ifndef BOARD_AP_PASSWORD
#define BOARD_AP_PASSWORD "12345678"
    constexpr bool kUsingDefaultApPassword = true;
#else
    constexpr bool kUsingDefaultApPassword = false;
#endif
    constexpr char kApPassword[] = BOARD_AP_PASSWORD;
    constexpr char kPreferencesNamespace[] = "wifi";
    constexpr char kFirmwareVersion[] = "1.0.0";

    constexpr char kBackendHost[] = "smart-notice-board-api.onrender.com";
    constexpr uint16_t kBackendPort = 443;
    constexpr char kBackendPath[] = "/ws";

    constexpr unsigned long kReconnectInitialDelayMs = 10000;
    constexpr unsigned long kReconnectMaximumDelayMs = 300000;
    constexpr unsigned long kConnectionTimeoutMs = 30000;
    constexpr unsigned long kInitialFrameHoldMs = 5000;
    constexpr unsigned long kScrollIntervalMs = 350;
    constexpr unsigned long kDeviceStatusIntervalMs = 30000;
    constexpr unsigned long kForgetDisconnectDelayMs = 250;
    constexpr unsigned long kTimeSyncRetryIntervalMs = 30000;
    constexpr time_t kMinimumValidTime = 1704067200;

    constexpr size_t kMaxNoticeLength = 200;
    constexpr size_t kLcdColumns = 16;
    constexpr size_t kFirstSegmentColumns = 8;

    // ESP32 pins: RS, E, DB4, DB5, DB6, DB7
    LiquidCrystal lcd(23, 22, 21, 19, 18, 17);
    WebServer server(80);
    WebSocketsClient webSocket;

    void displayNewNotice(const String &newNotice);
    void beginConnection(const String &ssid, const String &password);

    bool webSocketStarted = false;
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
    unsigned long reconnectDelayMs = kReconnectInitialDelayMs;
    unsigned long lastDeviceStatusAt = 0;
    unsigned long lastTimeSyncRequestAt = 0;
    unsigned long wifiForgetDisconnectStartedAt = 0;
    bool reconnectBackoffActive = false;
    bool wifiForgetDisconnectPending = false;
    bool firmwareUpdateInProgress = false;
    bool timeSyncRequested = false;
    String connectionTargetSsid;
    String connectionError;
    volatile bool stationGotIpEvent = false;
    volatile bool stationDisconnectedEvent = false;
    volatile uint8_t stationDisconnectReason = 0;
    bool webSocketAuthenticated = false;
    bool credentialCandidatePending = false;
    bool remoteWifiConfigurationActive = false;
    bool remoteWifiTargetConnected = false;
    bool remoteWifiConfigurationFailed = false;
    unsigned long remoteWifiConnectedAt = 0;
    String credentialCandidateSsid;
    String credentialCandidatePassword;
    String remoteWifiRequestId;
    String remoteWifiPreviousSsid;
    String remoteWifiPreviousPassword;
    String remoteWifiFailureMessage;
    String firmwareUpdateRequestId;

    constexpr unsigned long kBackendReconnectTimeoutMs = 60000;

    enum class CredentialLoadResult
    {
        Loaded,
        Missing,
        StorageError,
    };

    bool connectedToTargetNetwork()
    {
        return (!connectionInProgress || connectionSawDisconnect) &&
               WiFi.status() == WL_CONNECTED &&
               !connectionTargetSsid.isEmpty() &&
               WiFi.SSID() == connectionTargetSsid;
    }

    // JHD161A is physically one row of 16 characters. Internally, its
    // controller uses two 8-character DDRAM address sections. The LiquidCrystal
    // library's row 0 and row 1 addresses select those two visible sections.
    void writeLcd16(const String &text)
    {
        char frame[kLcdColumns + 1];
        for (size_t i = 0; i < kLcdColumns; ++i)
        {
            frame[i] = (i < text.length()) ? text[i] : ' ';
        }
        frame[kLcdColumns] = '\0';

        lcd.setCursor(0, 0);
        for (size_t i = 0; i < kFirstSegmentColumns; ++i)
        {
            lcd.write(static_cast<uint8_t>(frame[i]));
        }

        lcd.setCursor(0, 1);
        for (size_t i = kFirstSegmentColumns; i < kLcdColumns; ++i)
        {
            lcd.write(static_cast<uint8_t>(frame[i]));
        }
    }

    void displayNoticeFrame()
    {
        String frame;
        frame.reserve(kLcdColumns);

        for (size_t column = 0; column < kLcdColumns; ++column)
        {
            const size_t characterIndex = scrollPosition + column;
            frame += (characterIndex < notice.length())
                         ? notice[characterIndex]
                         : ' ';
        }
        writeLcd16(frame);
    }

    void updateNoticeScroll()
    {
        if (!noticeActive || notice.length() <= kLcdColumns)
        {
            return;
        }

        const unsigned long now = millis();
        const unsigned long interval =
            (scrollPosition == 0) ? kInitialFrameHoldMs : kScrollIntervalMs;

        if (now - lastScrollTime < interval)
        {
            return;
        }

        lastScrollTime = now;
        ++scrollPosition;

        // Show the trailing blank frame, then restart at the first character.
        if (scrollPosition > notice.length())
        {
            scrollPosition = 0;
        }

        displayNoticeFrame();
    }

    void addCorsHeaders()
    {
        server.sendHeader("Access-Control-Allow-Origin", "*");
        server.sendHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
        server.sendHeader("Access-Control-Allow-Headers", "Content-Type");
    }

    void sendJson(int statusCode, JsonDocument &document)
    {
        String body;
        serializeJson(document, body);
        addCorsHeaders();
        server.send(statusCode, "application/json", body);
    }

    void sendMessage(int statusCode, const char *message)
    {
        JsonDocument document;
        document["message"] = message;
        sendJson(statusCode, document);
    }

    void handleOptions()
    {
        addCorsHeaders();
        server.send(204);
    }

    CredentialLoadResult loadSavedCredentials(String &ssid, String &password)
    {
        if (!preferences.begin(kPreferencesNamespace, true))
        {
            Serial.println("ERROR: Could not open WiFi preferences");
            return CredentialLoadResult::StorageError;
        }

        if (preferences.isKey("activeSlot"))
        {
            const uint8_t activeSlot = preferences.getUChar("activeSlot", 0);
            const char *ssidKey = activeSlot == 0 ? "ssid0" : "ssid1";
            const char *passwordKey = activeSlot == 0 ? "password0" : "password1";
            ssid = preferences.getString(ssidKey, "");
            password = preferences.getString(passwordKey, "");
        }
        else
        {
            ssid = preferences.getString("ssid", "");
            password = preferences.getString("password", "");
        }
        preferences.end();
        return ssid.isEmpty()
                   ? CredentialLoadResult::Missing
                   : CredentialLoadResult::Loaded;
    }

    bool saveCredentials(const String &ssid, const String &password)
    {
        if (!preferences.begin(kPreferencesNamespace, false))
        {
            return false;
        }

        const bool hasActiveSlot = preferences.isKey("activeSlot");
        const uint8_t activeSlot = preferences.getUChar("activeSlot", 1);
        const uint8_t candidateSlot = hasActiveSlot ? 1 - activeSlot : 0;
        const char *ssidKey = candidateSlot == 0 ? "ssid0" : "ssid1";
        const char *passwordKey = candidateSlot == 0 ? "password0" : "password1";
        const bool written =
            preferences.putString(ssidKey, ssid) == ssid.length() &&
            preferences.putString(passwordKey, password) == password.length() &&
            preferences.getString(ssidKey, "") == ssid &&
            preferences.getString(passwordKey, "") == password &&
            preferences.putUChar("activeSlot", candidateSlot) == sizeof(uint8_t) &&
            preferences.getUChar("activeSlot", 255) == candidateSlot;
        preferences.end();
        return written;
    }

    bool validRequestId(const char *requestId)
    {
        if (requestId == nullptr || strlen(requestId) != 36)
        {
            return false;
        }

        for (size_t index = 0; index < 36; ++index)
        {
            if (index == 8 || index == 13 || index == 18 || index == 23)
            {
                if (requestId[index] != '-')
                {
                    return false;
                }
            }
            else if (!isxdigit(static_cast<unsigned char>(requestId[index])))
            {
                return false;
            }
        }
        return true;
    }

    void sendWifiConfigurationStatus(
        const String &requestId,
        const char *state,
        const String &ssid = "",
        const String &ip = "")
    {
        if (!webSocketAuthenticated || requestId.isEmpty())
        {
            return;
        }

        JsonDocument document;
        document["type"] = "WIFI_CONFIG_STATUS";
        document["requestId"] = requestId;
        document["state"] = state;
        if (!ssid.isEmpty())
        {
            document["ssid"] = ssid;
        }
        if (!ip.isEmpty())
        {
            document["ip"] = ip;
        }

        String message;
        serializeJson(document, message);
        webSocket.sendTXT(message);
    }

    void sendWifiForgetStatus(const String &requestId, const char *state)
    {
        if (!webSocketAuthenticated || requestId.isEmpty())
        {
            return;
        }

        JsonDocument document;
        document["type"] = "WIFI_FORGET_STATUS";
        document["requestId"] = requestId;
        document["state"] = state;
        String message;
        serializeJson(document, message);
        webSocket.sendTXT(message);
    }

    void sendFirmwareUpdateStatus(
        const String &requestId,
        const char *state,
        const String &version = "",
        const String &messageText = "")
    {
        if (!webSocketAuthenticated || requestId.isEmpty())
        {
            return;
        }

        JsonDocument document;
        document["type"] = "FIRMWARE_UPDATE_STATUS";
        document["requestId"] = requestId;
        document["state"] = state;
        if (!version.isEmpty())
        {
            document["version"] = version;
        }
        if (!messageText.isEmpty())
        {
            document["message"] = messageText;
        }

        String message;
        serializeJson(document, message);
        webSocket.sendTXT(message);
    }

    void reportFirmwareUpdateStatus(
        const char *state,
        const String &version)
    {
        sendFirmwareUpdateStatus(firmwareUpdateRequestId, state, version);
    }

    void handleRemoteFirmwareUpdate(JsonDocument &document)
    {
        const char *requestId = document["requestId"];
        if (!validRequestId(requestId))
        {
            return;
        }

        const String requestIdValue(requestId);
        if (
            !webSocketAuthenticated ||
            firmwareUpdateInProgress ||
            connectionInProgress ||
            remoteWifiConfigurationActive ||
            wifiForgetDisconnectPending)
        {
            sendFirmwareUpdateStatus(
                requestIdValue,
                "failed",
                "",
                "Another device operation is in progress.");
            return;
        }

        firmwareUpdateInProgress = true;
        firmwareUpdateRequestId = requestIdValue;
        String updatedVersion;
        String failureMessage;
        const bool updateStarted = firmware_update::performUpdate(
            kFirmwareVersion,
            reportFirmwareUpdateStatus,
            updatedVersion,
            failureMessage);
        if (
            !updateStarted &&
            failureMessage !=
                "The ESP32 already has the latest firmware.")
        {
            sendFirmwareUpdateStatus(
                firmwareUpdateRequestId,
                "failed",
                "",
                failureMessage);
        }
        firmwareUpdateInProgress = false;
        firmwareUpdateRequestId = "";
    }

    void sendDeviceStatus()
    {
        if (!webSocketAuthenticated)
        {
            return;
        }

        const bool connected = connectedToTargetNetwork();
        JsonDocument document;
        document["type"] = "DEVICE_STATUS";
        document["connected"] = connected;
        document["ssid"] = connected ? WiFi.SSID() : "";
        document["ip"] = connected ? WiFi.localIP().toString() : "";
        document["rssi"] = connected ? WiFi.RSSI() : 0;
        document["firmwareVersion"] = kFirmwareVersion;

        String message;
        serializeJson(document, message);
        webSocket.sendTXT(message);
        lastDeviceStatusAt = millis();
    }

    void handleRemoteWifiForget(JsonDocument &document)
    {
        const char *requestId = document["requestId"];
        if (!validRequestId(requestId))
        {
            return;
        }

        const String requestIdValue(requestId);
        if (
            !webSocketAuthenticated ||
            connectionInProgress ||
            remoteWifiConfigurationActive ||
            wifiForgetDisconnectPending)
        {
            sendWifiForgetStatus(requestIdValue, "failed");
            return;
        }

        sendWifiForgetStatus(requestIdValue, "accepted");

        if (!preferences.begin(kPreferencesNamespace, false))
        {
            sendWifiForgetStatus(requestIdValue, "failed");
            return;
        }

        const bool cleared = preferences.clear();
        const bool verified = cleared &&
                              !preferences.isKey("activeSlot") &&
                              !preferences.isKey("ssid0") &&
                              !preferences.isKey("password0") &&
                              !preferences.isKey("ssid1") &&
                              !preferences.isKey("password1") &&
                              !preferences.isKey("ssid") &&
                              !preferences.isKey("password");
        preferences.end();

        if (!verified)
        {
            sendWifiForgetStatus(requestIdValue, "failed");
            return;
        }

        credentialCandidatePending = false;
        credentialCandidateSsid = "";
        credentialCandidatePassword = "";
        reconnectEnabled = false;
        WiFi.setAutoReconnect(false);
        sendWifiForgetStatus(requestIdValue, "deleted");
        wifiForgetDisconnectPending = true;
        wifiForgetDisconnectStartedAt = millis();
    }

    void startRemoteWifiRollback(const String &reason)
    {
        remoteWifiConfigurationFailed = true;
        remoteWifiTargetConnected = false;
        remoteWifiFailureMessage = reason;
        credentialCandidatePending = false;
        credentialCandidateSsid = "";
        credentialCandidatePassword = "";
        connectionError = reason;

        if (!remoteWifiPreviousSsid.isEmpty())
        {
            beginConnection(
                remoteWifiPreviousSsid,
                remoteWifiPreviousPassword);
            connectionError = reason;
        }
    }

    void beginConnection(const String &ssid, const String &password)
    {
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
        Serial.println("Connecting to WiFi network");
    }

    void handleConnect()
    {
        if (connectionInProgress || remoteWifiConfigurationActive)
        {
            sendMessage(409, "A WiFi connection attempt is already in progress");
            return;
        }

        if (!server.hasArg("plain") || server.arg("plain").isEmpty())
        {
            sendMessage(400, "WiFi name is required");
            return;
        }

        String ssid;
        String password;

        JsonDocument document;
        const DeserializationError error =
            deserializeJson(document, server.arg("plain"));

        if (error)
        {
            sendMessage(400, "Invalid JSON WiFi details");
            return;
        }

        if (!document["ssid"].is<const char *>() ||
            !document["password"].is<const char *>())
        {
            sendMessage(400, "WiFi name and password must be strings");
            return;
        }

        ssid = document["ssid"].as<String>();
        password = document["password"].as<String>();
        ssid.trim();

        if (ssid.isEmpty())
        {
            sendMessage(400, "WiFi name is required");
            return;
        }

        if (ssid.length() > 32)
        {
            sendMessage(400, "WiFi name cannot exceed 32 bytes");
            return;
        }

        if (!password.isEmpty() &&
            (password.length() < 8 || password.length() > 63))
        {
            sendMessage(400, "WiFi password must be 8 to 63 characters, or empty for an open network");
            return;
        }

        credentialCandidatePending = true;
        credentialCandidateSsid = ssid;
        credentialCandidatePassword = password;
        beginConnection(ssid, password);
        sendMessage(202, "WiFi connection is in progress; saved credentials remain unchanged until connected");
    }

    void handleRemoteWifiConfiguration(JsonDocument &document)
    {
        const char *requestId = document["requestId"];
        if (!validRequestId(requestId))
        {
            return;
        }

        const String requestIdValue(requestId);
        const auto reportFailure = [&requestIdValue]()
        {
            sendWifiConfigurationStatus(requestIdValue, "failed");
        };

        if (
            !webSocketAuthenticated ||
            connectionInProgress ||
            remoteWifiConfigurationActive)
        {
            reportFailure();
            return;
        }

        if (
            !document["ssid"].is<const char *>() ||
            !document["password"].is<const char *>())
        {
            reportFailure();
            return;
        }

        String ssid = document["ssid"].as<String>();
        const String password = document["password"].as<String>();
        ssid.trim();
        if (
            ssid.isEmpty() ||
            ssid.length() > 32 ||
            (!password.isEmpty() &&
                (password.length() < 8 || password.length() > 63)))
        {
            reportFailure();
            return;
        }

        if (!connectedToTargetNetwork())
        {
            reportFailure();
            return;
        }

        String previousSsid;
        String previousPassword;
        if (loadSavedCredentials(previousSsid, previousPassword) !=
            CredentialLoadResult::Loaded)
        {
            reportFailure();
            return;
        }

        remoteWifiRequestId = requestIdValue;
        remoteWifiPreviousSsid = previousSsid;
        remoteWifiPreviousPassword = previousPassword;
        remoteWifiFailureMessage = "";
        remoteWifiConfigurationActive = true;
        remoteWifiTargetConnected = false;
        remoteWifiConfigurationFailed = false;
        credentialCandidatePending = true;
        credentialCandidateSsid = ssid;
        credentialCandidatePassword = password;

        sendWifiConfigurationStatus(remoteWifiRequestId, "accepted");
        sendWifiConfigurationStatus(remoteWifiRequestId, "connecting");
        webSocketAuthenticated = false;
        beginConnection(ssid, password);
    }

    void clearRemoteWifiConfiguration()
    {
        remoteWifiConfigurationActive = false;
        remoteWifiTargetConnected = false;
        remoteWifiConfigurationFailed = false;
        remoteWifiConnectedAt = 0;
        remoteWifiRequestId = "";
        remoteWifiPreviousSsid = "";
        remoteWifiPreviousPassword = "";
        remoteWifiFailureMessage = "";
    }

    void handleReconnect()
    {
        if (connectionInProgress || remoteWifiConfigurationActive)
        {
            sendMessage(409, "A WiFi connection attempt is already in progress");
            return;
        }

        String ssid;
        String password;

        const CredentialLoadResult result =
            loadSavedCredentials(ssid, password);
        if (result == CredentialLoadResult::StorageError)
        {
            sendMessage(500, "Could not read saved WiFi credentials");
            return;
        }
        if (result == CredentialLoadResult::Missing)
        {
            sendMessage(400, "No saved WiFi network exists");
            return;
        }

        if (connectedToTargetNetwork() && WiFi.SSID() == ssid)
        {
            sendMessage(200, "Already connected to the saved WiFi network");
            return;
        }

        beginConnection(ssid, password);
        sendMessage(202, "Reconnecting to the saved WiFi network");
    }

    void handleDisconnect()
    {
        if (remoteWifiConfigurationActive)
        {
            sendMessage(409, "A remote WiFi configuration is already in progress");
            return;
        }

        reconnectEnabled = false;
        connectionInProgress = false;
        connectionError = "";

        sendMessage(202, "Disconnecting from WiFi; saved credentials were kept");
        WiFi.setAutoReconnect(false);
        WiFi.disconnect(false, false);

        lcd.clear();
        writeLcd16("WiFi Disconnected");
    }

    void handleNotice()
    {
        if (!server.hasArg("plain") || server.arg("plain").isEmpty())
        {
            sendMessage(400, "Notice text is required");
            return;
        }

        JsonDocument document;
        const DeserializationError error =
            deserializeJson(document, server.arg("plain"));

        if (error)
        {
            sendMessage(400, "Invalid JSON notice");
            return;
        }

        String newNotice = document["notice"] | "";
        newNotice.trim();

        if (newNotice.isEmpty())
        {
            sendMessage(400, "Notice cannot be empty");
            return;
        }

        if (newNotice.length() > kMaxNoticeLength)
        {
            sendMessage(413, "Notice cannot exceed 200 characters");
            return;
        }

        displayNewNotice(newNotice);

        sendMessage(200, "Notice displayed on the LCD");
    }

    void webSocketEvent(WStype_t type, uint8_t *payload, size_t length)
    {

        switch (type)
        {

        case WStype_CONNECTED:
        {
            webSocketAuthenticated = false;
            Serial.println("Connected to Render WebSocket");

            JsonDocument authDocument;
            authDocument["type"] = "AUTH";
            authDocument["token"] = ESP32_DEVICE_TOKEN;

            String authMessage;
            serializeJson(authDocument, authMessage);

            webSocket.sendTXT(authMessage);

            Serial.println("Authentication message sent");
            break;
        }

        case WStype_DISCONNECTED:
            webSocketAuthenticated = false;
            Serial.println("Disconnected from Render WebSocket");
            break;

        case WStype_TEXT:
        {
            JsonDocument document;

            DeserializationError error =
                deserializeJson(document, payload, length);

            if (error)
            {
                Serial.println("Invalid WebSocket JSON");
                break;
            }

            const char *messageType = document["type"] | "";

            if (strcmp(messageType, "CONNECTION") == 0)
            {
                webSocketAuthenticated = true;
                Serial.println("ESP32 authenticated successfully");
                sendDeviceStatus();

                if (remoteWifiConfigurationActive)
                {
                    if (remoteWifiConfigurationFailed)
                    {
                        sendWifiConfigurationStatus(
                            remoteWifiRequestId,
                            "failed");
                        clearRemoteWifiConfiguration();
                    }
                    else if (remoteWifiTargetConnected)
                    {
                        if (saveCredentials(
                                credentialCandidateSsid,
                                credentialCandidatePassword))
                        {
                            credentialCandidatePending = false;
                            credentialCandidateSsid = "";
                            credentialCandidatePassword = "";
                            sendWifiConfigurationStatus(
                                remoteWifiRequestId,
                                "wifi_connected",
                                WiFi.SSID(),
                                WiFi.localIP().toString());
                            sendWifiConfigurationStatus(
                                remoteWifiRequestId,
                                "authenticated",
                                WiFi.SSID(),
                                WiFi.localIP().toString());
                            clearRemoteWifiConfiguration();
                        }
                        else
                        {
                            const String failure =
                                "Wi-Fi connected but the new credentials could not be saved.";
                            sendWifiConfigurationStatus(
                                remoteWifiRequestId,
                                "failed");
                            startRemoteWifiRollback(failure);
                            clearRemoteWifiConfiguration();
                        }
                    }
                }
            }

            else if (strcmp(messageType, "NOTICE") == 0)
            {

                String newNotice = document["notice"] | "";
                newNotice.trim();

                if (newNotice.isEmpty() ||
                    newNotice.length() > kMaxNoticeLength)
                {
                    Serial.println("Invalid notice received");
                    JsonDocument acknowledgement;
                    acknowledgement["type"] = "NOTICE_ACK";
                    acknowledgement["id"] = document["id"] | "";
                    acknowledgement["success"] = false;
                    acknowledgement["message"] = "Invalid notice";
                    String acknowledgementMessage;
                    serializeJson(acknowledgement, acknowledgementMessage);
                    webSocket.sendTXT(acknowledgementMessage);
                    break;
                }

                displayNewNotice(newNotice);

                JsonDocument acknowledgement;
                acknowledgement["type"] = "NOTICE_ACK";
                acknowledgement["id"] = document["id"] | "";
                acknowledgement["success"] = true;
                String acknowledgementMessage;
                serializeJson(acknowledgement, acknowledgementMessage);
                webSocket.sendTXT(acknowledgementMessage);
            }

            else if (strcmp(messageType, "WIFI_CONFIG") == 0)
            {
                handleRemoteWifiConfiguration(document);
            }
            else if (strcmp(messageType, "WIFI_FORGET") == 0)
            {
                handleRemoteWifiForget(document);
            }
            else if (strcmp(messageType, "FIRMWARE_UPDATE") == 0)
            {
                handleRemoteFirmwareUpdate(document);
            }

            break;
        }

        case WStype_ERROR:
            Serial.println("WebSocket connection error");
            break;

        default:
            break;
        }
    }

    void displayNewNotice(const String &newNotice)
    {
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
        Serial.println("LCD notice display started at character 1");
    }

    void handleRoot()
    {
        addCorsHeaders();
        server.send(200, "text/plain", "Smart Notice Board is online!");
        Serial.println("Root endpoint accessed");
    }

    void handleStatus()
    {
        JsonDocument document;
        const bool connected = connectedToTargetNetwork();
        String savedSsid;
        String savedPassword;
        const CredentialLoadResult credentialResult =
            loadSavedCredentials(savedSsid, savedPassword);

        document["connected"] = connected;
        document["connecting"] = connectionInProgress;
        document["ip"] = connected ? WiFi.localIP().toString() : "";
        document["ssid"] = connected ? WiFi.SSID() : "";
        document["rssi"] = connected ? WiFi.RSSI() : 0;
        document["firmwareVersion"] = kFirmwareVersion;
        document["apIp"] = WiFi.softAPIP().toString();
        document["savedCredentials"] =
            credentialResult == CredentialLoadResult::Loaded;
        document["connectionError"] = connectionError;
        sendJson(200, document);
    }

    void startAccessPoint()
    {
        const bool success = WiFi.softAP(kApName, kApPassword);
        if (!success)
        {
            Serial.println("ERROR: Failed to start setup access point");
            return;
        }

        Serial.println("Access point started");
        Serial.printf("AP name: %s\n", kApName);
        Serial.print("AP IP address: ");
        Serial.println(WiFi.softAPIP());
    }

    void setupServer()
    {
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

        server.onNotFound([]()
                          {
        addCorsHeaders();
        server.send(404, "application/json", "{\"message\":\"Not found\"}");
        Serial.println("Unknown HTTP endpoint requested"); });

        server.begin();
        Serial.println("HTTP server started on port 80");
    }

    void updateConnectionState()
    {
        const unsigned long now = millis();

        if (stationDisconnectedEvent)
        {
            stationDisconnectedEvent = false;
            Serial.printf(
                "WiFi station disconnected (reason %u)\n",
                stationDisconnectReason);
        }

        if (stationGotIpEvent)
        {
            stationGotIpEvent = false;
            Serial.print("WiFi station received IP: ");
            Serial.println(WiFi.localIP());
        }

        if (
            wifiForgetDisconnectPending &&
            now - wifiForgetDisconnectStartedAt >= kForgetDisconnectDelayMs)
        {
            wifiForgetDisconnectPending = false;
            if (webSocketStarted)
            {
                webSocket.disconnect();
                webSocketStarted = false;
                webSocketAuthenticated = false;
            }
            connectionInProgress = false;
            WiFi.disconnect(false, false);
            connectionSawDisconnect = true;
            connectionError = "";
            lcd.clear();
            writeLcd16("Setup Hotspot");
        }

        if (WiFi.status() != WL_CONNECTED)
        {
            connectionSawDisconnect = true;
        }

        const bool connected = connectedToTargetNetwork();

        if (
            webSocketAuthenticated &&
            now - lastDeviceStatusAt >= kDeviceStatusIntervalMs)
        {
            sendDeviceStatus();
        }

        if (connected)
        {
            if (!remoteWifiConfigurationFailed)
            {
                connectionError = "";
            }

            if (connectionInProgress)
            {
                connectionInProgress = false;
                Serial.println("WiFi connected!");
                Serial.print("ESP32 IP address: ");
                Serial.println(WiFi.localIP());
                reconnectDelayMs = kReconnectInitialDelayMs;
                reconnectBackoffActive = false;

                if (credentialCandidatePending)
                {
                    if (remoteWifiConfigurationActive)
                    {
                        if (connectionTargetSsid == credentialCandidateSsid)
                        {
                            remoteWifiTargetConnected = true;
                            remoteWifiConnectedAt = now;
                        }
                    }
                    else
                    {
                        if (saveCredentials(
                                credentialCandidateSsid,
                                credentialCandidatePassword))
                        {
                            connectionError = "";
                        }
                        else
                        {
                            connectionError =
                                "WiFi connected, but credentials could not be saved.";
                        }
                        credentialCandidatePending = false;
                        credentialCandidateSsid = "";
                        credentialCandidatePassword = "";
                    }
                }

                lcd.clear();
                writeLcd16(WiFi.localIP().toString());
            }

            const time_t currentTime = time(nullptr);
            if (currentTime < kMinimumValidTime)
            {
                connectionError =
                    "Waiting for network time before secure backend connection.";
                if (
                    !timeSyncRequested ||
                    now - lastTimeSyncRequestAt >= kTimeSyncRetryIntervalMs)
                {
                    configTime(
                        0,
                        0,
                        "pool.ntp.org",
                        "time.cloudflare.com");
                    timeSyncRequested = true;
                    lastTimeSyncRequestAt = now;
                    Serial.println("Requesting network time for TLS validation");
                }
                return;
            }

            // Start secure WebSocket connection to Render only after the
            // system clock is valid for certificate-date verification.
            if (!webSocketStarted)
            {
                webSocket.onEvent(webSocketEvent);
                webSocket.setReconnectInterval(5000);
                webSocket.enableHeartbeat(25000, 5000, 2);

                webSocket.beginSslWithCA(
                    kBackendHost,
                    kBackendPort,
                    kBackendPath,
                    kTrustedCaCertificates);

                webSocketStarted = true;

                Serial.println(
                    "Starting secure WebSocket connection to Render...");
            }

            if (
                remoteWifiConfigurationActive &&
                remoteWifiTargetConnected &&
                !webSocketAuthenticated &&
                now - remoteWifiConnectedAt >= kBackendReconnectTimeoutMs)
            {
                startRemoteWifiRollback(
                    "WiFi connected, but the backend did not reconnect. Restoring the previous network.");
            }

            return;
        }

        if (connectionInProgress &&
            now - connectionStartedAt >= kConnectionTimeoutMs)
        {
            connectionInProgress = false;
            lastReconnectAttemptAt = now;
            if (reconnectBackoffActive)
            {
                reconnectDelayMs = min(
                    reconnectDelayMs * 2,
                    kReconnectMaximumDelayMs);
            }
            else
            {
                reconnectBackoffActive = true;
            }
            connectionError =
                "WiFi connection timed out. Check the network name, password, and signal.";
            Serial.println("WiFi connection attempt timed out");
            WiFi.setAutoReconnect(false);
            WiFi.disconnect(false, false);
            connectionSawDisconnect = true;
            WiFi.setAutoReconnect(reconnectEnabled);
            lcd.clear();
            writeLcd16("WiFi Failed");

            if (!remoteWifiConfigurationActive)
            {
                credentialCandidatePending = false;
                credentialCandidateSsid = "";
                credentialCandidatePassword = "";
            }

            if (
                remoteWifiConfigurationActive &&
                !remoteWifiConfigurationFailed)
            {
                startRemoteWifiRollback(
                    "The requested WiFi network could not be reached. Restoring the previous network.");
            }
        }

        if (reconnectEnabled &&
            !connectionInProgress &&
            now - lastReconnectAttemptAt >= reconnectDelayMs)
        {
            String ssid;
            String password;

            if (loadSavedCredentials(ssid, password) ==
                CredentialLoadResult::Loaded)
            {
                beginConnection(ssid, password);
                Serial.println("Retrying saved WiFi connection");
            }
        }

    }

} // namespace

void setup()
{
    Serial.begin(115200);
    delay(500);

    Serial.println();
    Serial.println("Starting Smart Notice Board...");
    if (kUsingDefaultApPassword)
    {
        Serial.println(
            "WARNING: setup AP uses its default password; set BOARD_AP_PASSWORD in include/secrets.h");
    }

    lcd.begin(16, 2);
    lcd.noAutoscroll();
    lcd.leftToRight();
    lcd.noCursor();
    lcd.noBlink();
    lcd.clear();
    writeLcd16("Starting Board");

    WiFi.mode(WIFI_AP_STA);
    WiFi.setAutoReconnect(true);
    WiFi.onEvent([](WiFiEvent_t event, WiFiEventInfo_t info)
                 {
        if (event == ARDUINO_EVENT_WIFI_STA_GOT_IP) {
            stationGotIpEvent = true;
        } else if (event == ARDUINO_EVENT_WIFI_STA_DISCONNECTED) {
            stationDisconnectReason = info.wifi_sta_disconnected.reason;
            stationDisconnectedEvent = true;
        } });

    startAccessPoint();
    setupServer();

    String savedSSID;
    String savedPassword;

    const CredentialLoadResult credentialResult =
        loadSavedCredentials(savedSSID, savedPassword);
    if (credentialResult == CredentialLoadResult::Loaded)
    {
        beginConnection(savedSSID, savedPassword);
    }
    else
    {
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

void loop()
{
    server.handleClient();
    updateConnectionState();

    if (webSocketStarted)
    {
        webSocket.loop();
    }

    updateNoticeScroll();
    delay(2);
}
