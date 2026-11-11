#pragma once

#define BOARD_OTA_LATEST_RELEASE_API_URL \
    "https://api.github.com/repos/bhargavvenkatasai21-cpu/Smart-Notice-Board/releases/latest"
#define BOARD_OTA_RELEASE_ASSET_PREFIX \
    "https://github.com/bhargavvenkatasai21-cpu/Smart-Notice-Board/releases/download/"

// Configure with the 32-byte Ed25519 public key in lowercase or uppercase hex.
// This public key is the trust anchor; keep its matching private key offline.
#define BOARD_OTA_ED25519_PUBLIC_KEY_HEX "73d954f5590cfc0fda105647ff4c0969033f4b2876380c9e559722a98915cb2c"