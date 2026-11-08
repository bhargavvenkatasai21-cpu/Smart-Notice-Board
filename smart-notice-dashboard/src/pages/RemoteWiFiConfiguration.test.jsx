import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import RemoteWiFiConfiguration from "./RemoteWiFiConfiguration.jsx";
import {
  getFirmwareUpdate,
  getRemoteWifiConfiguration,
  getRemoteWifiForget,
  startRemoteWifiConfiguration,
  startFirmwareUpdate,
  startRemoteWifiForget,
} from "../services/esp32Service.js";

vi.mock("../services/esp32Service.js", () => ({
  getFirmwareUpdate: vi.fn(),
  getRemoteWifiConfiguration: vi.fn(),
  getRemoteWifiForget: vi.fn(),
  startRemoteWifiConfiguration: vi.fn(),
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
        sessionToken="session-token"
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
      "session-token",
      "Office WiFi",
      "password123",
    );
    expect(getRemoteWifiConfiguration).toHaveBeenCalledWith(
      "session-token",
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
        sessionToken="session-token"
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
        sessionToken="session-token"
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
        sessionToken="session-token"
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
    expect(startRemoteWifiForget).toHaveBeenCalledWith("session-token");
    expect(getRemoteWifiForget).toHaveBeenCalledWith(
      "session-token",
      "forget-123",
    );
    expect(onConfigured).toHaveBeenCalledOnce();
  });

  it("reports OTA success only after the ESP32 reconnects with the new version", async () => {
    const user = userEvent.setup();
    const onConfigured = vi.fn().mockResolvedValue(undefined);
    startFirmwareUpdate.mockResolvedValue({
      requestId: "firmware-123",
      state: "command_sent",
    });
    getFirmwareUpdate.mockResolvedValue({
      requestId: "firmware-123",
      state: "verified",
      version: "1.0.1",
    });

    render(
      <RemoteWiFiConfiguration
        deviceConnected
        onConfigured={onConfigured}
        sessionToken="session-token"
        wifiStatus={{ connected: true, firmwareVersion: "1.0.0" }}
      />,
    );
    await user.click(
      screen.getByRole("button", { name: "Check for signed update" }),
    );
    expect(
      await screen.findByText(
        /reconnected with the updated firmware/,
        {},
        { timeout: 3000 },
      ),
    ).toBeInTheDocument();
    expect(startFirmwareUpdate).toHaveBeenCalledWith("session-token");
    expect(getFirmwareUpdate).toHaveBeenCalledWith(
      "session-token",
      "firmware-123",
    );
    expect(onConfigured).toHaveBeenCalledOnce();
  });
});
