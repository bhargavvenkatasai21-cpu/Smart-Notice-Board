import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import RemoteWiFiConfiguration from "./RemoteWiFiConfiguration.jsx";
import {
  getRemoteWifiConfiguration,
  startRemoteWifiConfiguration,
} from "../services/esp32Service.js";

vi.mock("../services/esp32Service.js", () => ({
  getRemoteWifiConfiguration: vi.fn(),
  startRemoteWifiConfiguration: vi.fn(),
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
});
