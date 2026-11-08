import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App.jsx";
import {
  connectWiFi,
  createDashboardSession,
  getBackendHealth,
  getDeviceStatus,
  getESP32Address,
  getStatus,
  logoutDashboardSession,
} from "./services/esp32Service.js";

vi.mock("./services/esp32Service.js", () => ({
  connectWiFi: vi.fn(),
  createDashboardSession: vi.fn(),
  disconnectWiFi: vi.fn(),
  getBackendHealth: vi.fn(),
  getDeviceStatus: vi.fn(),
  getESP32Address: vi.fn(),
  getStatus: vi.fn(),
  logoutDashboardSession: vi.fn(),
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
    window.localStorage.clear();
    getESP32Address.mockReturnValue("http://192.168.4.1");
    getBackendHealth.mockResolvedValue({
      status: "OK",
      service: "Smart Notice Board Backend",
    });
    createDashboardSession.mockImplementation(async (accessCode, rememberMe) => ({
      success: true,
      sessionToken: "test-session-token",
      expiresAt: rememberMe ? "2026-12-08T00:00:00.000Z" : "2026-11-09T00:00:00.000Z",
    }));
    getDeviceStatus.mockResolvedValue({ connected: false });
    logoutDashboardSession.mockResolvedValue({ success: true });
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

  it("rejects an empty access code without contacting the backend", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: "Sign in" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Enter the dashboard access code.",
    );
    expect(createDashboardSession).not.toHaveBeenCalled();
  });

  it("authenticates with the backend and shows its device and WebSocket status", async () => {
    const user = userEvent.setup();
    getDeviceStatus.mockResolvedValue(remoteConnected);
    render(<App />);

    await user.type(screen.getByLabelText("Dashboard access code"), "operator-code");
    await user.click(screen.getByRole("button", { name: "Sign in" }));

    expect(createDashboardSession).toHaveBeenCalledWith("operator-code", false);
    expect(getDeviceStatus).toHaveBeenCalledWith("test-session-token");
    expect(await screen.findByText("Connected to the backend")).toBeInTheDocument();
    expect(screen.getByText("Device-to-backend channel")).toBeInTheDocument();
    expect(screen.getByText("WebSocket").parentElement).toHaveTextContent("Online");
    expect(screen.getByText("Last device communication").parentElement).toHaveTextContent(
      new Date(remoteConnected.lastSeenAt).toLocaleString(),
    );
    expect(screen.getByText("Meeting at 10")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sign out" })).toBeInTheDocument();
  });

  it("does not persist a session when Remember me is unchecked", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.type(screen.getByLabelText("Dashboard access code"), "one-time-code");
    expect(screen.getByRole("checkbox", { name: /Remember me/ })).not.toBeChecked();
    await user.click(screen.getByRole("button", { name: "Sign in" }));

    expect(await screen.findByRole("button", { name: "Sign out" })).toBeInTheDocument();
    expect(window.localStorage.getItem("smart-notice-board-dashboard-session")).toBeNull();
  });

  it("persists only the session token after successful login when Remember me is selected", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.type(screen.getByLabelText("Dashboard access code"), "remembered-code");
    await user.click(screen.getByRole("checkbox", { name: /Remember me/ }));
    await user.click(screen.getByRole("button", { name: "Sign in" }));

    expect(await screen.findByRole("button", { name: "Sign out" })).toBeInTheDocument();
    expect(createDashboardSession).toHaveBeenCalledWith("remembered-code", true);
    expect(getDeviceStatus).toHaveBeenCalledWith("test-session-token");
    expect(
      window.localStorage.getItem("smart-notice-board-dashboard-session"),
    ).toBe("test-session-token");
    expect(window.localStorage.getItem("smart-notice-board-dashboard-token")).toBeNull();
  });

  it("automatically restores and verifies a remembered session on startup", async () => {
    window.localStorage.setItem(
      "smart-notice-board-dashboard-session",
      "restored-session",
    );
    getDeviceStatus.mockResolvedValue(remoteConnected);

    render(<App />);

    expect(getDeviceStatus).toHaveBeenCalledWith("restored-session");
    expect(await screen.findByText("Connected to the backend")).toBeInTheDocument();
    expect(screen.getByText("Meeting at 10")).toBeInTheDocument();
    expect(screen.queryByLabelText("Dashboard access code")).not.toBeInTheDocument();
  });

  it("removes old remembered API tokens without treating them as sessions", async () => {
    window.localStorage.setItem("smart-notice-board-dashboard-token", "legacy-token");

    render(<App />);

    expect(await screen.findByLabelText("Dashboard access code")).toBeInTheDocument();
    expect(window.localStorage.getItem("smart-notice-board-dashboard-token")).toBeNull();
    expect(getDeviceStatus).not.toHaveBeenCalled();
  });

  it.each([
    ["invalid", "Unauthorized"],
    ["expired", "Dashboard token expired"],
  ])("removes an %s remembered session rejected by the backend", async (_kind, message) => {
    const error = new Error(message);
    error.status = 401;
    getDeviceStatus.mockRejectedValue(error);
    window.localStorage.setItem(
      "smart-notice-board-dashboard-session",
      "rejected-session",
    );

    render(<App />);

    expect(await screen.findByText(/session is no longer valid/)).toBeInTheDocument();
    expect(await screen.findByLabelText("Dashboard access code")).toBeInTheDocument();
    expect(window.localStorage.getItem("smart-notice-board-dashboard-session")).toBeNull();
    expect(screen.getByRole("checkbox", { name: /Remember me/ })).not.toBeChecked();
  });

  it("revokes and removes a remembered session on logout", async () => {
    const user = userEvent.setup();
    getDeviceStatus.mockResolvedValue(remoteConnected);
    window.localStorage.setItem(
      "smart-notice-board-dashboard-session",
      "saved-session",
    );

    render(<App />);
    await screen.findByRole("button", { name: "Sign out" });
    await user.click(screen.getByRole("button", { name: "Sign out" }));

    expect(await screen.findByLabelText("Dashboard access code")).toBeInTheDocument();
    expect(window.localStorage.getItem("smart-notice-board-dashboard-session")).toBeNull();
    expect(logoutDashboardSession).toHaveBeenCalledWith("saved-session");
  });

  it("reports invalid dashboard credentials without exposing a false device status", async () => {
    const user = userEvent.setup();
    render(<App />);

    createDashboardSession.mockRejectedValue(new Error("Incorrect dashboard access code."));
    await user.type(screen.getByLabelText("Dashboard access code"), "bad-code");
    await user.click(screen.getByRole("button", { name: "Sign in" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Incorrect dashboard access code.");
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
