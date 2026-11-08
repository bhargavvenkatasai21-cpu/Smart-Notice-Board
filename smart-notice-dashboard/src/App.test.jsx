import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App.jsx";
import {
  connectWiFi,
  getBackendHealth,
  getDeviceStatus,
  getESP32Address,
  getStatus,
} from "./services/esp32Service.js";

vi.mock("./services/esp32Service.js", () => ({
  connectWiFi: vi.fn(),
  disconnectWiFi: vi.fn(),
  getBackendHealth: vi.fn(),
  getDeviceStatus: vi.fn(),
  getESP32Address: vi.fn(),
  getStatus: vi.fn(),
  reconnectWiFi: vi.fn(),
  sendNotice: vi.fn(),
  setESP32Address: vi.fn((address) => address),
}));

const localDisconnected = {
  connected: false,
  connecting: false,
  ssid: "",
  ip: "",
  apIp: "192.168.4.1",
  savedCredentials: false,
  connectionError: "",
  reachableAddress: "http://192.168.4.1",
};

const remoteConnected = {
  connected: true,
  websocketConnected: true,
  lastSeenAt: "2026-11-08T10:00:00.000Z",
  latestNotice: { notice: "Meeting at 10", sentAt: "2026-11-08T10:00:00.000Z" },
};

describe("Dashboard backend integration and local provisioning", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getESP32Address.mockReturnValue("http://192.168.4.1");
    getBackendHealth.mockResolvedValue({
      status: "OK",
      service: "Smart Notice Board Backend",
    });
    getDeviceStatus.mockResolvedValue({ connected: false });
    getStatus.mockResolvedValue(localDisconnected);
    connectWiFi.mockResolvedValue({
      message: "Wi-Fi credentials saved; connection is in progress",
    });
  });

  it("checks backend availability on load without assuming the ESP32 is online", async () => {
    render(<App />);

    await waitFor(() => expect(getBackendHealth).toHaveBeenCalled());
    expect(await screen.findByText("Online")).toBeInTheDocument();
    expect(screen.getByText("Sign in to check device status")).toBeInTheDocument();
    expect(getDeviceStatus).not.toHaveBeenCalled();
  });

  it("authenticates with the backend and shows its device and WebSocket status", async () => {
    const user = userEvent.setup();
    getDeviceStatus.mockResolvedValue(remoteConnected);
    render(<App />);

    await user.type(screen.getByLabelText("Dashboard access token"), "operator-token");
    await user.click(screen.getByRole("button", { name: "Sign in" }));

    expect(getDeviceStatus).toHaveBeenCalledWith("operator-token");
    expect(await screen.findByText("Connected to the backend")).toBeInTheDocument();
    expect(screen.getByText("Device-to-backend channel")).toBeInTheDocument();
    expect(screen.getByText("Meeting at 10")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sign out" })).toBeInTheDocument();
  });

  it("reports invalid dashboard credentials without exposing a false device status", async () => {
    const user = userEvent.setup();
    getDeviceStatus.mockRejectedValue(new Error("Unauthorized"));
    render(<App />);

    await user.type(screen.getByLabelText("Dashboard access token"), "bad-token");
    await user.click(screen.getByRole("button", { name: "Sign in" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Unauthorized");
    expect(screen.getByText("Sign in to check device status")).toBeInTheDocument();
  });

  it("keeps local Wi-Fi provisioning available without dashboard authentication", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: "Device setup" }));
    expect(
      await screen.findByRole("heading", { name: "Wi-Fi configuration" }),
    ).toBeInTheDocument();

    await user.type(
      screen.getByLabelText("Wi-Fi network name (SSID)"),
      "Home WiFi",
    );
    await user.type(screen.getByLabelText("Wi-Fi password"), "password123");
    await user.click(screen.getByRole("button", { name: "Connect to Wi-Fi" }));

    await waitFor(() =>
      expect(connectWiFi).toHaveBeenCalledWith("Home WiFi", "password123"),
    );
    expect(await screen.findByText(/connection is in progress/)).toBeInTheDocument();
  });
});
