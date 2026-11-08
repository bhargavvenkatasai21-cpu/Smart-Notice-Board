#include "firmware_update.h"

#include <ArduinoJson.h>
#include <HTTPClient.h>
#include <Update.h>
#include <WiFiClientSecure.h>
#include <mbedtls/sha256.h>
#include <sodium.h>
#include <string.h>

#include "ota_config.h"
#include "trust_roots.h"

namespace
{
    constexpr size_t kMaximumManifestBytes = 4096;
    constexpr size_t kDownloadBufferBytes = 4096;
    constexpr uint64_t kMaximumFirmwareBytes = 1507328;
    constexpr unsigned long kRequestTimeoutMs = 15000;
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

    bool fetchManifest(String &manifest)
    {
        WiFiClientSecure client;
        client.setCACert(kTrustedCaCertificates);

        HTTPClient http;
        http.setTimeout(kRequestTimeoutMs);
        http.setFollowRedirects(HTTPC_STRICT_FOLLOW_REDIRECTS);
        http.setRedirectLimit(kMaximumHttpRedirects);
        if (!http.begin(client, BOARD_OTA_MANIFEST_URL))
        {
            return false;
        }

        const int statusCode = http.GET();
        if (statusCode != HTTP_CODE_OK)
        {
            http.end();
            return false;
        }

        const int contentLength = http.getSize();
        if (
            contentLength <= 0 ||
            static_cast<size_t>(contentLength) > kMaximumManifestBytes)
        {
            http.end();
            return false;
        }

        manifest = http.getString();
        http.end();
        return !manifest.isEmpty() &&
               manifest.length() <= kMaximumManifestBytes;
    }

    bool validateManifest(
        JsonDocument &document,
        const String &currentVersion,
        SemanticVersion &newVersion,
        size_t &firmwareSize,
        String &firmwareUrl,
        unsigned char *expectedHash,
        String &manifestVersion,
        String &failureMessage)
    {
        if (
            document["schemaVersion"] != 1 ||
            !document["version"].is<const char *>() ||
            !document["firmwareUrl"].is<const char *>() ||
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
        const uint64_t declaredSize = document["size"] | 0ULL;

        SemanticVersion current;
        if (
            !parseVersion(currentVersion, current) ||
            !parseVersion(manifestVersion, newVersion))
        {
            failureMessage = "The current or published firmware version is invalid.";
            return false;
        }

        if (
            declaredSize == 0 ||
            declaredSize > kMaximumFirmwareBytes ||
            declaredSize > static_cast<uint64_t>(ESP.getFreeSketchSpace()) ||
            declaredSize > SIZE_MAX)
        {
            failureMessage = "The release firmware size is invalid or exceeds the OTA slot.";
            return false;
        }

        const String expectedUrl =
            String(BOARD_OTA_RELEASE_ASSET_PREFIX) +
            "v" + manifestVersion + "/firmware.bin";
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
        if (versionComparison == 0)
        {
            failureMessage = "The ESP32 already has the latest firmware.";
            return false;
        }
        if (versionComparison < 0)
        {
            failureMessage = "Firmware downgrade was rejected.";
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
        WiFiClientSecure client;
        client.setCACert(kTrustedCaCertificates);

        HTTPClient http;
        http.setTimeout(kRequestTimeoutMs);
        http.setFollowRedirects(HTTPC_STRICT_FOLLOW_REDIRECTS);
        http.setRedirectLimit(kMaximumHttpRedirects);
        if (!http.begin(client, firmwareUrl))
        {
            failureMessage = "Could not start the firmware download.";
            return false;
        }

        const int statusCode = http.GET();
        if (statusCode != HTTP_CODE_OK)
        {
            http.end();
            failureMessage = "The firmware download failed.";
            return false;
        }

        const int contentLength = http.getSize();
        if (
            contentLength <= 0 ||
            static_cast<size_t>(contentLength) != firmwareSize)
        {
            http.end();
            failureMessage = "The firmware download size did not match the signed manifest.";
            return false;
        }

        if (!Update.begin(firmwareSize, U_FLASH))
        {
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
        Stream *stream = http.getStreamPtr();
        bool downloadSucceeded = stream != nullptr;
        while (downloadSucceeded && received < firmwareSize)
        {
            const size_t remaining = firmwareSize - received;
            const size_t wanted = min(sizeof(buffer), remaining);
            const size_t count = stream->readBytes(buffer, wanted);
            if (
                count == 0 ||
                Update.write(buffer, count) != count ||
                mbedtls_sha256_update(
                    &hashContext,
                    buffer,
                    count) != 0)
            {
                downloadSucceeded = false;
                break;
            }

            received += count;
            yield();
        }

        unsigned char actualHash[32];
        const bool hashSucceeded =
            mbedtls_sha256_finish(&hashContext, actualHash) == 0;
        mbedtls_sha256_free(&hashContext);
        http.end();

        if (
            !downloadSucceeded ||
            received != firmwareSize ||
            !hashSucceeded ||
            sodium_memcmp(actualHash, expectedHash, sizeof(actualHash)) != 0)
        {
            Update.abort();
            failureMessage =
                "The downloaded firmware failed size or SHA-256 verification.";
            return false;
        }

        reportStatus("verifying", version);
        if (!Update.end())
        {
            failureMessage = String("ESP32 rejected the firmware image: ") +
                             Update.errorString();
            return false;
        }

        reportStatus("rebooting", version);
        delay(300);
        ESP.restart();
        return true;
    }
}

namespace firmware_update
{
    bool performUpdate(
        const char *currentVersion,
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
        String manifest;
        if (!fetchManifest(manifest))
        {
            failureMessage =
                "Could not securely download the GitHub release manifest.";
            return false;
        }

        JsonDocument document;
        if (deserializeJson(document, manifest))
        {
            failureMessage = "The GitHub release manifest is not valid JSON.";
            return false;
        }

        String firmwareUrl;
        size_t firmwareSize = 0;
        unsigned char expectedHash[32];
        SemanticVersion newVersion;
        if (!validateManifest(
                document,
                String(currentVersion),
                newVersion,
                firmwareSize,
                firmwareUrl,
                expectedHash,
                updatedVersion,
                failureMessage))
        {
            if (failureMessage == "The ESP32 already has the latest firmware.")
            {
                reportStatus("up_to_date", String(currentVersion));
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
