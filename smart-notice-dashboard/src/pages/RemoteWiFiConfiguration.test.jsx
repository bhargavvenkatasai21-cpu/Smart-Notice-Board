import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import RemoteWiFiConfiguration from "./RemoteWiFiConfiguration.jsx";
import {
  getFirmwareUpdate,
  getRemoteWifiConfiguration,
  getRemoteWifiForget,
  startRemoteWifiConfiguration,
  startFirmwareCheck,
  startFirmwareUpdate,
  startRemoteWifiForget,
} from "../services/esp32Service.js";

vi.mock("../services/esp32Service.js", () => ({
  getFirmwareUpdate: vi.fn(),
  getRemoteWifiConfiguration: vi.fn(),
  getRemoteWifiForget: vi.fn(),
  startRemoteWifiConfiguration: vi.fn(),
  startFirmwareCheck: vi.fn(),
  startFirmwareUpdate: vi.fn(),
  startRemoteWifiForget: vi.fn(),
}));

describe("remote ESP32 Wi-Fi configuration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    window.sessionStorage.clear();
  });

  it("reports authenticated success and clears the password field", async () => {
    const user = userEvent.setup();
    const onConfigured = vi.fn().mockResolvedValue(undefined);
    startRemoteWifiConfiguration.mockResolvedValue({
      requestId: "request-123",
    });
    getRemoteWifiConfiguration.mockResolvedValue({
      requestId: "request-123",
      state: "authenticated",
      message: "Wi-Fi connected and ESP32 authenticated with the backend.",
    });

    render(
      <RemoteWiFiConfiguration
        deviceConnected
        onConfigured={onConfigured}
        wifiStatus={{ connected: false }}
      />,
    );

    await user.type(screen.getByLabelText("Wi-Fi network name (SSID)"), "Office WiFi");
    await user.type(screen.getByLabelText("Wi-Fi password"), "password123");
    await user.click(screen.getByRole("button", { name: "Show Wi-Fi password" }));
    expect(screen.getByLabelText("Wi-Fi password")).toHaveAttribute("type", "text");

    await user.click(screen.getByRole("button", { name: "Connect to Wi-Fi" }));
    expect(
      await screen.findByText(
        /Wi-Fi connected and ESP32 authenticated/,
        {},
        { timeout: 4000 },
      ),
    ).toBeInTheDocument();

    expect(startRemoteWifiConfiguration).toHaveBeenCalledWith(
      "Office WiFi",
      "password123",
    );
    expect(getRemoteWifiConfiguration).toHaveBeenCalledWith(
      "request-123",
    );
    expect(onConfigured).toHaveBeenCalledOnce();
    expect(screen.getByLabelText("Wi-Fi password")).toHaveValue("");
    expect(screen.getByLabelText("Wi-Fi password")).toHaveAttribute("type", "password");
    expect(window.localStorage.length).toBe(0);
    expect(window.sessionStorage.length).toBe(0);
  });

  it("blocks remote submission while the ESP32 is offline", () => {
    render(
      <RemoteWiFiConfiguration
        deviceConnected={false}
        onConfigured={vi.fn()}
        wifiStatus={{ connected: false }}
      />,
    );

    expect(screen.getByRole("button", { name: "ESP32 offline" })).toBeDisabled();
    expect(startRemoteWifiConfiguration).not.toHaveBeenCalled();
  });

  it("shows a backend-reported failure and clears the password", async () => {
    const user = userEvent.setup();
    startRemoteWifiConfiguration.mockResolvedValue({
      requestId: "request-456",
    });
    getRemoteWifiConfiguration.mockResolvedValue({
      requestId: "request-456",
      state: "failed",
      message: "The ESP32 could not connect to that Wi-Fi network.",
    });

    render(
      <RemoteWiFiConfiguration
        deviceConnected
        onConfigured={vi.fn()}
        wifiStatus={{ connected: false }}
      />,
    );

    await user.type(screen.getByLabelText("Wi-Fi network name (SSID)"), "Office WiFi");
    await user.type(screen.getByLabelText("Wi-Fi password"), "password123");
    await user.click(screen.getByRole("button", { name: "Connect to Wi-Fi" }));

    expect(
      await screen.findByRole("alert", {}, { timeout: 3000 }),
    ).toHaveTextContent("The ESP32 could not connect to that Wi-Fi network.");
    expect(screen.getByLabelText("Wi-Fi password")).toHaveValue("");
  });

  it("requires confirmation and reports successful Wi-Fi credential deletion", async () => {
    const user = userEvent.setup();
    const onConfigured = vi.fn().mockResolvedValue(undefined);
    startRemoteWifiForget.mockResolvedValue({
      requestId: "forget-123",
      state: "command_sent",
    });
    getRemoteWifiForget.mockResolvedValue({
      requestId: "forget-123",
      state: "deleted",
    });

    render(
      <RemoteWiFiConfiguration
        deviceConnected
        onConfigured={onConfigured}
        wifiStatus={{
          connected: true,
          rssi: -61,
          firmwareVersion: "1.0.0",
        }}
      />,
    );

    expect(screen.getByText("-61 dBm")).toBeInTheDocument();
    expect(screen.getByText("1.0.0")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Forget saved Wi-Fi" }));
    expect(
      screen.getByText(/permanently deletes saved Wi-Fi credentials/i),
    ).toBeInTheDocument();
    expect(startRemoteWifiForget).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("button", { name: "Confirm deletion" })).toBeNull();

    await user.click(screen.getByRole("button", { name: "Forget saved Wi-Fi" }));
    await user.click(screen.getByRole("button", { name: "Confirm deletion" }));
    expect(
      await screen.findByText(
        /Saved Wi-Fi credentials were deleted/,
        {},
        { timeout: 3000 },
      ),
    ).toBeInTheDocument();
    expect(startRemoteWifiForget).toHaveBeenCalledWith();
    expect(getRemoteWifiForget).toHaveBeenCalledWith(
      "forget-123",
    );
    expect(onConfigured).toHaveBeenCalledOnce();
  });

  it("checks a release separately and installs only after explicit selection", async () => {
    const user = userEvent.setup();
    const onConfigured = vi.fn().mockResolvedValue(undefined);
    startFirmwareCheck.mockResolvedValue({
      requestId: "firmware-123",
      state: "command_sent",
    });
    startFirmwareUpdate.mockResolvedValue({
      requestId: "install-123",
      state: "command_sent",
    });
    getFirmwareUpdate
      .mockResolvedValueOnce({
        requestId: "firmware-123",
        state: "available",
        version: "1.0.1",
      })
      .mockResolvedValueOnce({
        requestId: "install-123",
        state: "verified",
        version: "1.0.1",
      });

    render(
      <RemoteWiFiConfiguration
        deviceConnected
        onConfigured={onConfigured}
        wifiStatus={{ connected: true, firmwareVersion: "1.0.0" }}
      />,
    );
    await user.click(
      screen.getByRole("button", { name: "Check for signed update" }),
    );
    expect(
      await screen.findByRole("button", { name: "Install v1.0.1" }, { timeout: 3000 }),
    ).toBeInTheDocument();
    expect(startFirmwareCheck).toHaveBeenCalledWith();
    expect(startFirmwareUpdate).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Install v1.0.1" }));
    expect(
      await screen.findByText(
        /reconnected with the updated firmware/,
        {},
        { timeout: 3000 },
      ),
    ).toBeInTheDocument();
    expect(startFirmwareUpdate).toHaveBeenCalledWith(false);
    expect(getFirmwareUpdate).toHaveBeenCalledWith(
      "install-123",
    );
    expect(onConfigured).toHaveBeenCalledOnce();
  });

  it("requires a separate confirmation to reinstall the current firmware", async () => {
    const user = userEvent.setup();
    startFirmwareCheck.mockResolvedValue({
      requestId: "check-123",
      state: "command_sent",
    });
    startFirmwareUpdate.mockResolvedValue({
      requestId: "install-123",
      state: "command_sent",
    });
    getFirmwareUpdate
      .mockResolvedValueOnce({
        requestId: "check-123",
        state: "up_to_date",
        version: "1.0.3",
      })
      .mockResolvedValueOnce({
        requestId: "install-123",
        state: "verified",
        version: "1.0.3",
      });

    render(
      <RemoteWiFiConfiguration
        deviceConnected
        onConfigured={vi.fn().mockResolvedValue(undefined)}
        wifiStatus={{ connected: true, firmwareVersion: "1.0.3" }}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Check for signed update" }));
    await user.click(
      await screen.findByRole("button", { name: "Reinstall current firmware" }, {
        timeout: 3000,
      }),
    );
    expect(startFirmwareUpdate).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Confirm reinstall" }));

    expect(startFirmwareUpdate).toHaveBeenCalledWith(true);
    expect(
      await screen.findByText(/reconnected with the updated firmware/, {}, {
        timeout: 3000,
      }),
    ).toBeInTheDocument();
  });
});
