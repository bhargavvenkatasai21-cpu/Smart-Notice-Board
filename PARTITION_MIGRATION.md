# ESP32 partition layout and migration

The project targets a 4 MiB ESP32 flash chip with two OTA application slots.
`partitions.csv` is selected by `platformio.ini`.

| Partition | Offset | Size | End |
|---|---:|---:|---:|
| NVS | `0x9000` | 20 KiB | `0xE000` |
| OTA data | `0xE000` | 8 KiB | `0x10000` |
| App slot 0 | `0x10000` | `0x170000` (1,507,328 bytes) | `0x180000` |
| App slot 1 | `0x180000` | `0x170000` (1,507,328 bytes) | `0x2F0000` |
| SPIFFS | `0x2F0000` | 1 MiB | `0x3F0000` |
| Coredump | `0x3F0000` | 64 KiB | `0x400000` |

The custom table was decoded with Espressif's partition-table generator. The
latest compiled firmware image measured 1,354,512 bytes, leaving 152,816 bytes
(10.1%) in each OTA slot. Monitor this headroom as firmware grows.

## Migration warning

This layout moves and shrinks SPIFFS from the default partition layout. No
application SPIFFS use was found during the source audit, but external data
must be backed up before migration.

The approved migration is a manual USB full-flash erase followed by a firmware
upload using this partition table. Erasing removes NVS data, including saved
Wi-Fi credentials. After upload, reconnect to the `SmartNoticeBoard` setup
access point and enter the Wi-Fi credentials again. Keep USB recovery access
available until setup, WSS authentication, notices, and OTA are tested.

These are instructions only. No erase, firmware upload, or physical board
operation was performed by the coding agent. Do not run migration commands
until the owner has confirmed the device, access to the board, and recovery
plan.
