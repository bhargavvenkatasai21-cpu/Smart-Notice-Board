#include "firmware_update.h"

#include <ArduinoJson.h>
#include <HTTPClient.h>
#include <Update.h>
#include <WiFiClientSecure.h>
#include <stdio.h>
#include <mbedtls/sha256.h>
#include <sodium.h>
#include <string.h>

#include "ota_config.h"
#include "trust_roots.h"

namespace
{
    constexpr size_t kMaximumManifestBytes = 4096;
    constexpr size_t kMaximumReleaseMetadataBytes = 8192;
    constexpr size_t kDownloadBufferBytes = 4096;
    constexpr uint64_t kMaximumFirmwareBytes = 1507328;
    constexpr unsigned long kRequestTimeoutMs = 60000;
    constexpr unsigned long kStreamTimeoutMs = 60000;
    constexpr size_t kProgressLogIntervalBytes = 64 * 1024;
    constexpr uint16_t kMaximumHttpRedirects = 5;
    constexpr char kSignatureContext[] = "SmartNoticeBoard-OTA-v1\n";

    struct SemanticVersion
    {
        uint32_t major;
        uint32_t minor;
        uint32_t patch;
    };

    bool parseVersion(const String &value, SemanticVersion &version)
    {
        uint32_t components[3] = {0, 0, 0};
        size_t component = 0;
        bool hasDigit = false;

        if (value.isEmpty())
        {
            return false;
        }

        for (size_t index = 0; index < value.length(); ++index)
        {
            const char character = value[index];
            if (character >= '0' && character <= '9')
            {
                if (
                    !hasDigit &&
                    character == '0' &&
                    index + 1 < value.length() &&
                    value[index + 1] >= '0' &&
                    value[index + 1] <= '9')
                {
                    return false;
                }
                hasDigit = true;
                const uint32_t digit = static_cast<uint32_t>(character - '0');
                if (components[component] > (UINT32_MAX - digit) / 10)
                {
                    return false;
                }
                components[component] = components[component] * 10 + digit;
            }
            else if (
                character == '.' &&
                hasDigit &&
                component < 2 &&
                index + 1 < value.length() &&
                value[index + 1] >= '0' &&
                value[index + 1] <= '9')
            {
                ++component;
                hasDigit = false;
            }
            else
            {
                return false;
            }
        }

        if (component != 2 || !hasDigit)
        {
            return false;
        }

        version = {components[0], components[1], components[2]};
        return true;
    }

    int compareVersions(
        const SemanticVersion &left,
        const SemanticVersion &right)
    {
        if (left.major != right.major)
        {
            return left.major > right.major ? 1 : -1;
        }
        if (left.minor != right.minor)
        {
            return left.minor > right.minor ? 1 : -1;
        }
        if (left.patch != right.patch)
        {
            return left.patch > right.patch ? 1 : -1;
        }
        return 0;
    }

    int hexValue(char character)
    {
        if (character >= '0' && character <= '9')
        {
            return character - '0';
        }
        if (character >= 'a' && character <= 'f')
        {
            return character - 'a' + 10;
        }
        if (character >= 'A' && character <= 'F')
        {
            return character - 'A' + 10;
        }
        return -1;
    }

    bool decodeHex(
        const String &hex,
        unsigned char *output,
        size_t outputLength)
    {
        if (hex.length() != outputLength * 2)
        {
            return false;
        }

        for (size_t index = 0; index < outputLength; ++index)
        {
            const int high = hexValue(hex[index * 2]);
            const int low = hexValue(hex[index * 2 + 1]);
            if (high < 0 || low < 0)
            {
                return false;
            }
            output[index] = static_cast<unsigned char>((high << 4) | low);
        }
        return true;
    }

    bool fetchText(
        const char *url,
        size_t maximumBytes,
        String &responseBody,
        const char *description,
        const char *acceptHeader)
    {
        Serial.printf("[OTA] Preparing secure %s connection...\n", description);

        WiFiClientSecure client;
        client.setCACert(kTrustedCaCertificates);

        HTTPClient http;
        http.setTimeout(kRequestTimeoutMs);
        http.setFollowRedirects(HTTPC_FORCE_FOLLOW_REDIRECTS);
        http.setRedirectLimit(kMaximumHttpRedirects);

        Serial.printf("[OTA] Opening URL: %s\n", url);

        if (!http.begin(client, url))
        {
            Serial.printf("[OTA] ERROR: Could not start %s HTTPS request.\n", description);
            return false;
        }

        if (acceptHeader != nullptr)
        {
            http.addHeader("Accept", acceptHeader);
        }
        http.addHeader("User-Agent", "SmartNoticeBoard-ESP32");
        Serial.printf("[OTA] Sending %s HTTPS GET request...\n", description);

        const int statusCode = http.GET();

        Serial.printf("[OTA] %s HTTP status: %d\n", description, statusCode);
        const String finalUrl = http.getLocation();
        if (!finalUrl.isEmpty())
        {
            Serial.printf("[OTA] Final response URL: %s\n", finalUrl.c_str());
        }

        if (statusCode != HTTP_CODE_OK)
        {
            Serial.printf(
                "[OTA] ERROR: %s request failed: %s\n",
                description,
                HTTPClient::errorToString(statusCode).c_str());
            http.end();
            return false;
        }

        const int contentLength = http.getSize();
        Serial.printf("[OTA] %s Content-Length: %d bytes\n", description, contentLength);

        if (
            contentLength == 0 ||
            (contentLength > 0 &&
             static_cast<size_t>(contentLength) > maximumBytes))
        {
            Serial.printf("[OTA] ERROR: Invalid %s response size.\n", description);
            http.end();
            return false;
        }

        responseBody = http.getString();
        Serial.printf(
            "[OTA] %s bytes received: %u\n",
            description,
            static_cast<unsigned int>(responseBody.length()));

        http.end();

        if (
            responseBody.isEmpty() ||
            responseBody.length() > maximumBytes ||
            (contentLength > 0 &&
             responseBody.length() != static_cast<size_t>(contentLength)))
        {
            Serial.printf(
                "[OTA] ERROR: %s response was empty, truncated, or oversized.\n",
                description);
            return false;
        }
        return true;
    }

    bool fetchManifest(
        String &manifest,
        String &releaseTag,
        String &releaseVersion)
    {
        String releaseMetadata;
        if (!fetchText(
                BOARD_OTA_LATEST_RELEASE_API_URL,
                kMaximumReleaseMetadataBytes,
                releaseMetadata,
                "GitHub latest stable release metadata",
                "application/vnd.github+json"))
        {
            return false;
        }

        JsonDocument releaseDocument;
        if (deserializeJson(releaseDocument, releaseMetadata))
        {
            Serial.println("[OTA] ERROR: GitHub release metadata is not valid JSON.");
            return false;
        }

        if (
            !releaseDocument["tag_name"].is<const char *>() ||
            !releaseDocument["draft"].is<bool>() ||
            !releaseDocument["prerelease"].is<bool>() ||
            releaseDocument["draft"].as<bool>() ||
            releaseDocument["prerelease"].as<bool>() ||
            !releaseDocument["assets"].is<JsonArray>())
        {
            Serial.println("[OTA] ERROR: GitHub did not return a published stable release.");
            return false;
        }

        releaseTag = releaseDocument["tag_name"].as<String>();
        if (
            releaseTag.length() < 2 ||
            (releaseTag[0] != 'v' && releaseTag[0] != 'V'))
        {
            Serial.println("[OTA] ERROR: Stable release tag has an invalid format.");
            return false;
        }
        releaseVersion = releaseTag.substring(1);
        SemanticVersion parsedReleaseVersion;
        if (!parseVersion(releaseVersion, parsedReleaseVersion))
        {
            Serial.println("[OTA] ERROR: Stable release tag is not semantic major.minor.patch.");
            return false;
        }

        const String versionedManifestName =
            "manifest-" + releaseVersion + ".json";
        String versionedManifestUrl;
        String fallbackManifestUrl;
        const String assetPrefix =
            String(BOARD_OTA_RELEASE_ASSET_PREFIX) + releaseTag + "/";
        for (JsonObjectConst asset :
             releaseDocument["assets"].as<JsonArrayConst>())
        {
            if (
                !asset["name"].is<const char *>() ||
                !asset["browser_download_url"].is<const char *>())
            {
                continue;
            }
            const String name = asset["name"].as<String>();
            const String url = asset["browser_download_url"].as<String>();
            if (url != assetPrefix + name)
            {
                continue;
            }
            if (name == versionedManifestName)
            {
                versionedManifestUrl = url;
            }
            else if (name == "manifest.json")
            {
                fallbackManifestUrl = url;
            }
        }

        const String manifestUrl = !versionedManifestUrl.isEmpty()
            ? versionedManifestUrl
            : fallbackManifestUrl;
        if (manifestUrl.isEmpty())
        {
            Serial.println(
                "[OTA] ERROR: Stable release has no supported signed manifest asset.");
            return false;
        }

        Serial.printf(
            "[OTA] Latest stable release: %s; manifest asset: %s\n",
            releaseTag.c_str(),
            manifestUrl.c_str());
        return fetchText(
            manifestUrl.c_str(),
            kMaximumManifestBytes,
            manifest,
            "signed firmware manifest",
            "application/json");
    }

    bool validateManifest(
        JsonDocument &document,
        const String &currentVersion,
        const String &releaseTag,
        bool allowReinstall,
        bool forCheck,
        SemanticVersion &newVersion,
        size_t &firmwareSize,
        String &firmwareUrl,
        unsigned char *expectedHash,
        String &manifestVersion,
        bool &sameVersion,
        String &failureMessage)
    {
        if (
            document["schemaVersion"] != 1 ||
            !document["version"].is<const char *>() ||
            !document["firmwareUrl"].is<const char *>() ||
            !document["size"].is<uint32_t>() ||
            !document["sha256"].is<const char *>() ||
            !document["signature"].is<const char *>())
        {
            failureMessage = "The release manifest has an invalid shape.";
            return false;
        }

        manifestVersion = document["version"].as<String>();
        firmwareUrl = document["firmwareUrl"].as<String>();
        const String hashHex = document["sha256"].as<String>();
        const String signatureHex = document["signature"].as<String>();
        const uint64_t declaredSize = document["size"].as<uint32_t>();
        SemanticVersion releaseVersion;

        SemanticVersion current;
        if (
            !parseVersion(currentVersion, current) ||
            !parseVersion(manifestVersion, newVersion) ||
            !parseVersion(releaseTag.substring(1), releaseVersion) ||
            compareVersions(newVersion, releaseVersion) != 0)
        {
            failureMessage = "The current firmware, release tag, or manifest version is invalid.";
            return false;
        }

        const size_t availableSpace = ESP.getFreeSketchSpace();
        Serial.printf(
            "[OTA] OTA slot capacity available: %u bytes\n",
            static_cast<unsigned int>(availableSpace));
        if (
            declaredSize == 0 ||
            declaredSize > kMaximumFirmwareBytes ||
            declaredSize > static_cast<uint64_t>(availableSpace) ||
            declaredSize > SIZE_MAX)
        {
            failureMessage =
                "The release firmware size is invalid or exceeds the OTA slot capacity.";
            return false;
        }

        const String expectedUrl =
            String(BOARD_OTA_RELEASE_ASSET_PREFIX) +
            releaseTag + "/firmware.bin";
        unsigned char signature[crypto_sign_BYTES];
        if (
            firmwareUrl != expectedUrl ||
            !decodeHex(hashHex, expectedHash, 32) ||
            !decodeHex(signatureHex, signature, sizeof(signature)))
        {
            failureMessage = "The release manifest contains invalid firmware metadata.";
            return false;
        }

        if (
            strlen(BOARD_OTA_ED25519_PUBLIC_KEY_HEX) !=
            crypto_sign_PUBLICKEYBYTES * 2)
        {
            failureMessage = "OTA is disabled: configure the Ed25519 public key.";
            return false;
        }

        unsigned char publicKey[crypto_sign_PUBLICKEYBYTES];
        if (!decodeHex(
                BOARD_OTA_ED25519_PUBLIC_KEY_HEX,
                publicKey,
                sizeof(publicKey)))
        {
            failureMessage = "The configured OTA public key is invalid.";
            return false;
        }

        String signedContent = String(kSignatureContext) +
                               manifestVersion + "\n" +
                               String(static_cast<unsigned long long>(declaredSize)) + "\n" +
                               hashHex + "\n" + firmwareUrl;
        if (sodium_init() < 0 ||
            crypto_sign_ed25519_verify_detached(
                signature,
                reinterpret_cast<const unsigned char *>(signedContent.c_str()),
                signedContent.length(),
                publicKey) != 0)
        {
            failureMessage = "The release manifest signature is invalid.";
            return false;
        }

        const int versionComparison = compareVersions(newVersion, current);
        if (versionComparison < 0)
        {
            failureMessage = "Firmware downgrade was rejected.";
            return false;
        }
        sameVersion = versionComparison == 0;
        if (!forCheck && sameVersion && !allowReinstall)
        {
            failureMessage =
                "Same-version reinstall requires explicit confirmation.";
            return false;
        }

        firmwareSize = static_cast<size_t>(declaredSize);
        return true;
    }

    bool downloadAndInstall(
        const String &firmwareUrl,
        size_t firmwareSize,
        const unsigned char *expectedHash,
        const String &version,
        firmware_update::StatusCallback reportStatus,
        String &failureMessage)
    {
        Serial.println("[OTA] Starting firmware download...");

        WiFiClientSecure client;
        client.setCACert(kTrustedCaCertificates);
        client.setTimeout(kStreamTimeoutMs);

        HTTPClient http;
        http.setTimeout(kRequestTimeoutMs);
        http.setReuse(false);
        http.setFollowRedirects(HTTPC_STRICT_FOLLOW_REDIRECTS);
        http.setRedirectLimit(kMaximumHttpRedirects);

        if (!http.begin(client, firmwareUrl))
        {
            Serial.printf(
                "[OTA] ERROR: Could not start HTTPS download for %s\n",
                firmwareUrl.c_str());
            failureMessage = "Could not start the firmware download.";
            return false;
        }

        Serial.println("[OTA] Sending firmware HTTPS GET request...");
        const int statusCode = http.GET();
        Serial.printf("[OTA] Firmware HTTP status: %d\n", statusCode);
        const String finalUrl = http.getLocation();
        if (!finalUrl.isEmpty())
        {
            Serial.printf("[OTA] Firmware final response URL: %s\n",
                          finalUrl.c_str());
        }
        if (statusCode != HTTP_CODE_OK)
        {
            Serial.printf("[OTA] Firmware HTTP error: %s\n",
                          HTTPClient::errorToString(statusCode).c_str());
            http.end();
            failureMessage = "The firmware download failed.";
            return false;
        }

        const int contentLength = http.getSize();
        Serial.printf("[OTA] Firmware HTTP content length: %d bytes\n",
                      contentLength);
        Serial.printf("[OTA] Signed manifest size: %u bytes\n",
                      static_cast<unsigned int>(firmwareSize));
        if (contentLength == 0)
        {
            Serial.println("[OTA] ERROR: Firmware response has an empty body.");
            http.end();
            failureMessage = "The firmware server returned an empty image.";
            return false;
        }

        // A positive Content-Length must match the signed manifest. A value of
        // -1 means the server did not provide a length; the signed size and
        // SHA-256 checks below remain authoritative.
        if (contentLength > 0 &&
            static_cast<size_t>(contentLength) != firmwareSize)
        {
            Serial.println("[OTA] ERROR: HTTP content length differs from signed size.");
            http.end();
            failureMessage =
                "The firmware download size did not match the signed manifest.";
            return false;
        }

        Stream *stream = http.getStreamPtr();
        if (stream == nullptr)
        {
            Serial.println("[OTA] ERROR: Firmware response stream is unavailable.");
            http.end();
            failureMessage = "The firmware download stream is unavailable.";
            return false;
        }
        stream->setTimeout(kStreamTimeoutMs);

        if (!Update.begin(firmwareSize, U_FLASH))
        {
            Serial.printf("[OTA] ERROR: Update.begin failed: %s\n",
                          Update.errorString());
            http.end();
            failureMessage = String("OTA partition could not be opened: ") +
                             Update.errorString();
            return false;
        }

        reportStatus("downloading", version);
        mbedtls_sha256_context hashContext;
        mbedtls_sha256_init(&hashContext);
        if (mbedtls_sha256_starts(&hashContext, 0) != 0)
        {
            mbedtls_sha256_free(&hashContext);
            Update.abort();
            http.end();
            failureMessage = "Could not initialize firmware hash verification.";
            return false;
        }

        uint8_t buffer[kDownloadBufferBytes];
        size_t received = 0;
        size_t nextProgressLog = kProgressLogIntervalBytes;
        bool downloadSucceeded = true;

        while (received < firmwareSize)
        {
            const size_t remaining = firmwareSize - received;
            const size_t wanted =
                (sizeof(buffer) < remaining) ? sizeof(buffer) : remaining;
            const size_t count = stream->readBytes(buffer, wanted);

            if (count == 0)
            {
                Serial.printf("[OTA] Download stopped at byte %u\n",
                              static_cast<unsigned int>(received));
                Serial.printf("[OTA] Stream connected: %s\n",
                              client.connected() ? "YES" : "NO");
                Serial.printf("[OTA] Stream available: %d\n",
                              stream->available());
                downloadSucceeded = false;
                break;
            }

            const size_t written = Update.write(buffer, count);
            if (written != count)
            {
                Serial.printf("[OTA] ERROR: Flash write failed at byte %u\n",
                              static_cast<unsigned int>(received));
                downloadSucceeded = false;
                break;
            }

            if (mbedtls_sha256_update(&hashContext, buffer, count) != 0)
            {
                Serial.println("[OTA] ERROR: SHA-256 update failed.");
                downloadSucceeded = false;
                break;
            }

            received += count;
            if (received >= nextProgressLog)
            {
                Serial.printf("[OTA] Download progress: %u / %u bytes\n",
                              static_cast<unsigned int>(received),
                              static_cast<unsigned int>(firmwareSize));
                nextProgressLog += kProgressLogIntervalBytes;
            }
            yield();
        }

        unsigned char actualHash[32] = {0};
        const bool hashSucceeded =
            mbedtls_sha256_finish(&hashContext, actualHash) == 0;
        mbedtls_sha256_free(&hashContext);

        Serial.printf("[OTA] Download succeeded: %s\n",
                      downloadSucceeded ? "YES" : "NO");
        Serial.printf("[OTA] Bytes received: %u\n",
                      static_cast<unsigned int>(received));
        Serial.printf("[OTA] Expected bytes: %u\n",
                      static_cast<unsigned int>(firmwareSize));
        Serial.printf("[OTA] SHA-256 calculation: %s\n",
                      hashSucceeded ? "SUCCESS" : "FAILED");

        char actualHashHex[65] = {};
        char expectedHashHex[65] = {};
        for (size_t index = 0; index < sizeof(actualHash); ++index)
        {
            snprintf(
                actualHashHex + index * 2,
                sizeof(actualHashHex) - index * 2,
                "%02x",
                actualHash[index]);
            snprintf(
                expectedHashHex + index * 2,
                sizeof(expectedHashHex) - index * 2,
                "%02x",
                expectedHash[index]);
        }
        Serial.printf("[OTA] Expected SHA-256: %s\n", expectedHashHex);
        Serial.printf("[OTA] Actual SHA-256:   %s\n", actualHashHex);

        const bool hashMatches =
            hashSucceeded &&
            sodium_memcmp(actualHash, expectedHash, sizeof(actualHash)) == 0;
        Serial.printf("[OTA] SHA-256 match: %s\n",
                      hashMatches ? "YES" : "NO");

        http.end();

        if (!downloadSucceeded || received != firmwareSize)
        {
            Update.abort();
            Serial.println("[OTA] ERROR: Firmware transfer was incomplete.");
            failureMessage = "The firmware download was interrupted or incomplete.";
            return false;
        }
        if (!hashSucceeded || !hashMatches)
        {
            Update.abort();
            Serial.println("[OTA] ERROR: Downloaded firmware SHA-256 did not match.");
            failureMessage = "The downloaded firmware SHA-256 did not match the signed manifest.";
            return false;
        }

        reportStatus("verifying", version);
        if (!Update.end())
        {
            Serial.printf("[OTA] ERROR: Update.end failed: %s\n",
                          Update.errorString());
            failureMessage = String("ESP32 rejected the firmware image: ") +
                             Update.errorString();
            return false;
        }

        Serial.println("[OTA] Firmware image verified and written successfully.");
        reportStatus("rebooting", version);
        delay(300);
        ESP.restart();
        return true;
    }

    bool loadLatestManifest(
        const String &currentVersion,
        bool allowReinstall,
        bool forCheck,
        String &firmwareUrl,
        size_t &firmwareSize,
        unsigned char *expectedHash,
        String &manifestVersion,
        bool &sameVersion,
        String &failureMessage)
    {
        String manifest;
        String releaseTag;
        String releaseVersion;
        if (!fetchManifest(manifest, releaseTag, releaseVersion))
        {
            failureMessage =
                "Could not securely download the latest stable GitHub release manifest.";
            return false;
        }

        JsonDocument document;
        if (deserializeJson(document, manifest))
        {
            failureMessage = "The GitHub release manifest is not valid JSON.";
            return false;
        }

        SemanticVersion releaseTagVersion;
        if (!parseVersion(releaseVersion, releaseTagVersion))
        {
            failureMessage = "The latest stable release tag is invalid.";
            return false;
        }

        SemanticVersion newVersion;
        return validateManifest(
            document,
            currentVersion,
            releaseTag,
            allowReinstall,
            forCheck,
            newVersion,
            firmwareSize,
            firmwareUrl,
            expectedHash,
            manifestVersion,
            sameVersion,
            failureMessage);
    }
}

namespace firmware_update
{
    bool checkForUpdate(
        const char *currentVersion,
        StatusCallback reportStatus,
        String &availableVersion,
        String &failureMessage)
    {
        if (reportStatus == nullptr)
        {
            failureMessage = "Firmware update status reporting is unavailable.";
            return false;
        }
        if (
            strlen(BOARD_OTA_ED25519_PUBLIC_KEY_HEX) !=
            crypto_sign_PUBLICKEYBYTES * 2)
        {
            failureMessage = "OTA is disabled: configure the Ed25519 public key.";
            return false;
        }

        reportStatus("checking", "");
        String firmwareUrl;
        size_t firmwareSize = 0;
        unsigned char expectedHash[32] = {};
        bool sameVersion = false;
        if (!loadLatestManifest(
                String(currentVersion),
                false,
                true,
                firmwareUrl,
                firmwareSize,
                expectedHash,
                availableVersion,
                sameVersion,
                failureMessage))
        {
            return false;
        }

        if (sameVersion)
        {
            reportStatus("up_to_date", availableVersion);
        }
        else
        {
            reportStatus("available", availableVersion);
        }
        return true;
    }

    bool performUpdate(
        const char *currentVersion,
        bool allowReinstall,
        StatusCallback reportStatus,
        String &updatedVersion,
        String &failureMessage)
    {
        if (reportStatus == nullptr)
        {
            failureMessage = "Firmware update status reporting is unavailable.";
            return false;
        }

        if (
            strlen(BOARD_OTA_ED25519_PUBLIC_KEY_HEX) !=
            crypto_sign_PUBLICKEYBYTES * 2)
        {
            failureMessage = "OTA is disabled: configure the Ed25519 public key.";
            return false;
        }

        reportStatus("checking", "");
        String firmwareUrl;
        size_t firmwareSize = 0;
        unsigned char expectedHash[32] = {};
        bool sameVersion = false;
        if (!loadLatestManifest(
                String(currentVersion),
                allowReinstall,
                false,
                firmwareUrl,
                firmwareSize,
                expectedHash,
                updatedVersion,
                sameVersion,
                failureMessage))
        {
            if (
                sameVersion &&
                failureMessage ==
                    "Same-version reinstall requires explicit confirmation.")
            {
                reportStatus("up_to_date", updatedVersion);
                return true;
            }
            return false;
        }

        return downloadAndInstall(
            firmwareUrl,
            firmwareSize,
            expectedHash,
            updatedVersion,
            reportStatus,
            failureMessage);
    }
}
