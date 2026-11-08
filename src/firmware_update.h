#pragma once

#include <Arduino.h>

namespace firmware_update
{
    using StatusCallback = void (*)(const char *, const String &);

    bool performUpdate(
        const char *currentVersion,
        StatusCallback reportStatus,
        String &updatedVersion,
        String &failureMessage);
}
