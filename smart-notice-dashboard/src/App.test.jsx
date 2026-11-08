import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App.jsx";
import {
  connectWiFi,
  getESP32Address,
  getStatus,
} from "./services/esp32Service.js";

vi.mock("./services/esp32Service.js", () => ({
  connectWiFi: vi.fn(),
  disconnectWiFi: vi.fn(),
  getESP32Address: vi.fn(),
  getStatus: vi.fn(),
  reconnectWiFi: vi.fn(),
  sendNotice: vi.fn(),
  setESP32Address: vi.fn((address) => address),
}));

const disconnected = {
  connected: false,
  connecting: false,
  ssid: "",
  ip: "",
  apIp: "192.168.4.1",
  savedCredentials: false,
  connectionError: "",
  reachableAddress: "http://192.168.4.1",
};

const connected = {
  connected: true,
  connecting: false,
  ssid: "Home WiFi",
  ip: "192.168.1.105",
  apIp: "192.168.4.1",
  savedCredentials: true,
  connectionError: "",
  reachableAddress: "http://192.168.4.1",
};

describe("App Wi-Fi provisioning", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getESP32Address.mockReturnValue("http://192.168.4.1");
    connectWiFi.mockResolvedValue({
      message: "Wi-Fi credentials saved; connection is in progress",
    });
  });

  it("navigates only after status confirms connection and shows the dynamic IP", async () => {
    const user = userEvent.setup();
    getStatus
      .mockResolvedValueOnce(disconnected)
      .mockResolvedValue(connected);
    render(<App />);

    await waitFor(() => expect(getStatus).toHaveBeenCalled());
    await user.type(
      screen.getByLabelText("Wi-Fi network name (SSID)"),
      "Home WiFi",
    );
    await user.type(screen.getByLabelText("Wi-Fi password"), "password123");
    await user.click(screen.getByRole("button", { name: "Connect to Wi-Fi" }));

    expect(connectWiFi).toHaveBeenCalledWith("Home WiFi", "password123");
    expect(
      await screen.findByRole("heading", { name: "Send a notice" }),
    ).toBeInTheDocument();
    expect(screen.getAllByText("192.168.1.105").length).toBeGreaterThan(0);
    expect(
      screen.getByText(/switch this device back to the Wi-Fi network named Home WiFi/),
    ).toBeInTheDocument();
  });

  it("does not navigate while the firmware reports connecting", async () => {
    const user = userEvent.setup();
    getStatus
      .mockResolvedValueOnce(disconnected)
      .mockResolvedValue({
        ...disconnected,
        connecting: true,
      });
    render(<App />);

    await waitFor(() => expect(getStatus).toHaveBeenCalled());
    await user.type(
      screen.getByLabelText("Wi-Fi network name (SSID)"),
      "Home WiFi",
    );
    await user.click(screen.getByRole("button", { name: "Connect to Wi-Fi" }));

    await waitFor(() =>
      expect(screen.getAllByText("Connecting").length).toBeGreaterThan(0),
    );
    expect(screen.queryByRole("heading", { name: "Send a notice" })).toBeNull();
    expect(
      screen.getByRole("button", { name: /Send Notice/ }),
    ).toBeDisabled();
  });

  it("shows a firmware-reported timeout and stays on Wi-Fi settings", async () => {
    const user = userEvent.setup();
    getStatus
      .mockResolvedValueOnce(disconnected)
      .mockResolvedValue({
        ...disconnected,
        connectionError: "WiFi connection timed out. Check the password.",
      });
    render(<App />);

    await waitFor(() => expect(getStatus).toHaveBeenCalled());
    await user.type(
      screen.getByLabelText("Wi-Fi network name (SSID)"),
      "Home WiFi",
    );
    await user.click(screen.getByRole("button", { name: "Connect to Wi-Fi" }));

    expect(
      await screen.findByText("WiFi connection timed out. Check the password."),
    ).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Send a notice" })).toBeNull();
  });

  it("reports provisioning access-point/network limitations", () => {
    getStatus.mockResolvedValue(disconnected);
    render(<App />);
    expect(
      screen.getByText(/The browser cannot switch networks for you/),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/client-isolation settings/),
    ).toBeInTheDocument();
  });
});
