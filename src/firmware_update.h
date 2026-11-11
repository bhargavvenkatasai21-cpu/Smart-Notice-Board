#pragma once

#include <Arduino.h>

namespace firmware_update
{
    using StatusCallback = void (*)(const char *, const String &);

    bool checkForUpdate(
        const char *currentVersion,
        StatusCallback reportStatus,
        String &availableVersion,
        String &failureMessage);

    bool performUpdate(
        const char *currentVersion,
        bool allowReinstall,
        StatusCallback reportStatus,
        String &updatedVersion,
        String &failureMessage);
}
