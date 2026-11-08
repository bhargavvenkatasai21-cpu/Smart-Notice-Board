#pragma once

#define BOARD_OTA_MANIFEST_URL \
    "https://github.com/bhargavvenkatasai21-cpu/Smart-Notice-Board/releases/latest/download/manifest.json"
#define BOARD_OTA_RELEASE_ASSET_PREFIX \
    "https://github.com/bhargavvenkatasai21-cpu/Smart-Notice-Board/releases/download/"

// Configure with the 32-byte Ed25519 public key in lowercase or uppercase hex.
// OTA fails closed while this placeholder is empty.
#define BOARD_OTA_ED25519_PUBLIC_KEY_HEX ""
