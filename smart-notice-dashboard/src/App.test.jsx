import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App.jsx";
import {
  connectWiFi,
  createDashboardSession,
  getBackendHealth,
  getDashboardSession,
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
  getDashboardSession: vi.fn(),
  getDeviceStatus: vi.fn(),
  getESP32Address: vi.fn(),
  getRemoteWifiConfiguration: vi.fn(),
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

function unauthorizedSessionError(code = "session_missing") {
  const error = new Error("Dashboard sign-in is required.");
  error.status = 401;
  error.code = code;
  return error;
}

describe("Dashboard authentication and local provisioning", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    getESP32Address.mockReturnValue("http://192.168.4.1");
    getBackendHealth.mockResolvedValue({
      status: "OK",
      service: "Smart Notice Board Backend",
    });
    getDashboardSession.mockRejectedValue(unauthorizedSessionError());
    createDashboardSession.mockResolvedValue({
      success: true,
      expiresAt: "2026-11-09T00:00:00.000Z",
    });
    getDeviceStatus.mockResolvedValue({ connected: false });
    logoutDashboardSession.mockResolvedValue({ success: true });
    getStatus.mockResolvedValue(localDisconnected);
    connectWiFi.mockResolvedValue({
      message: "Wi-Fi credentials saved; connection is in progress",
    });
  });

  it("checks backend availability without requesting protected status before sign-in", async () => {
    render(<App />);

    expect(await screen.findByLabelText("Dashboard access code")).toBeInTheDocument();
    await waitFor(() => expect(getBackendHealth).toHaveBeenCalled());
    expect(screen.getByText("Sign in to check device status")).toBeInTheDocument();
    expect(getDashboardSession).toHaveBeenCalledOnce();
    expect(getDeviceStatus).not.toHaveBeenCalled();
  });

  it("waits for cookie-session initialization before rendering the login route", async () => {
    let finishInitialization;
    getDashboardSession.mockReturnValue(
      new Promise((resolve) => {
        finishInitialization = resolve;
      }),
    );
    render(<App />);

    expect(screen.getByText("Checking dashboard session…")).toBeInTheDocument();
    expect(screen.queryByLabelText("Dashboard access code")).not.toBeInTheDocument();
    finishInitialization({ success: true, expiresAt: "2026-11-09T00:00:00.000Z" });
    expect(await screen.findByRole("button", { name: "Sign out" })).toBeInTheDocument();
  });

  it("rejects an empty access code without contacting the backend", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(await screen.findByRole("button", { name: "Sign in" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Enter the dashboard access code.",
    );
    expect(createDashboardSession).not.toHaveBeenCalled();
  });

  it("authenticates and shows device status without exposing a session token", async () => {
    const user = userEvent.setup();
    getDeviceStatus.mockResolvedValue(remoteConnected);
    render(<App />);

    await user.type(await screen.findByLabelText("Dashboard access code"), "operator-code");
    await user.click(screen.getByRole("button", { name: "Sign in" }));

    expect(createDashboardSession).toHaveBeenCalledWith("operator-code", false);
    expect(getDeviceStatus).toHaveBeenCalledWith();
    expect(await screen.findByText("Connected to the backend")).toBeInTheDocument();
    expect(screen.getByText("Device-to-backend channel")).toBeInTheDocument();
    expect(screen.getByText("WebSocket").parentElement).toHaveTextContent("Online");
    expect(screen.getByText("Last device communication").parentElement).toHaveTextContent(
      new Date(remoteConnected.lastSeenAt).toLocaleString(),
    );
    expect(await screen.findByText("Meeting at 10")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sign out" })).toBeInTheDocument();
    expect(window.localStorage.length).toBe(0);
  });

  it("passes Remember me to the server without storing the cookie token in browser storage", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.type(await screen.findByLabelText("Dashboard access code"), "remembered-code");
    await user.click(screen.getByRole("checkbox", { name: /Remember me/ }));
    await user.click(screen.getByRole("button", { name: "Sign in" }));

    expect(await screen.findByRole("button", { name: "Sign out" })).toBeInTheDocument();
    expect(createDashboardSession).toHaveBeenCalledWith("remembered-code", true);
    expect(window.localStorage.length).toBe(0);
    expect(window.sessionStorage.length).toBe(0);
  });

  it("restores a valid cookie session on refresh or in a new tab", async () => {
    getDashboardSession.mockResolvedValue({
      success: true,
      expiresAt: "2026-11-09T00:00:00.000Z",
    });
    getDeviceStatus.mockResolvedValue(remoteConnected);

    render(<App />);

    expect(await screen.findByRole("button", { name: "Sign out" })).toBeInTheDocument();
    expect(getDashboardSession).toHaveBeenCalledOnce();
    expect(getDeviceStatus).toHaveBeenCalledWith();
    expect(await screen.findByText("Meeting at 10")).toBeInTheDocument();
    expect(screen.queryByLabelText("Dashboard access code")).not.toBeInTheDocument();
    expect(window.localStorage.length).toBe(0);
  });

  it("refreshes device and WebSocket status automatically while backend stays online", async () => {
    getDashboardSession.mockResolvedValue({
      success: true,
      expiresAt: "2026-11-09T00:00:00.000Z",
    });
    getDeviceStatus
      .mockResolvedValueOnce(remoteConnected)
      .mockResolvedValue({
        ...remoteConnected,
        connected: false,
        websocketConnected: false,
      });

    render(<App />);

    expect(await screen.findByText("Connected to the backend")).toBeInTheDocument();
    expect(screen.getByText("ESP32").parentElement).toHaveTextContent("Online");

    await waitFor(
      () => {
        expect(screen.getByText("ESP32").parentElement).toHaveTextContent("Offline");
        expect(screen.getByText("WebSocket").parentElement).toHaveTextContent("Offline");
      },
      { interval: 100, timeout: 8000 },
    );

    expect(screen.getByText("Backend").parentElement).toHaveTextContent("Online");
    expect(getDeviceStatus.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText("Last device communication").parentElement).toHaveTextContent(
      new Date(remoteConnected.lastSeenAt).toLocaleString(),
    );
  }, 10000);

  it("keeps a valid session authenticated when device-status polling fails", async () => {
    getDashboardSession.mockResolvedValue({
      success: true,
      expiresAt: "2026-11-09T00:00:00.000Z",
    });
    getDeviceStatus.mockRejectedValue(new Error("Device status unavailable"));

    render(<App />);

    expect(await screen.findByRole("button", { name: "Sign out" })).toBeInTheDocument();
    expect(await screen.findByText("Device status unavailable")).toBeInTheDocument();
    expect(screen.queryByLabelText("Dashboard access code")).not.toBeInTheDocument();
  });

  it("shows a clear message when the cookie session has expired", async () => {
    getDashboardSession.mockRejectedValue(unauthorizedSessionError("session_invalid"));

    render(<App />);

    expect(await screen.findByText(/session expired or is no longer valid/i)).toBeInTheDocument();
    expect(await screen.findByLabelText("Dashboard access code")).toBeInTheDocument();
    expect(getDeviceStatus).not.toHaveBeenCalled();
  });

  it("keeps protected routes unavailable while session initialization fails", async () => {
    getDashboardSession.mockRejectedValue(new Error("Backend unavailable"));

    render(<App />);

    expect(await screen.findByRole("heading", { name: "Unable to verify dashboard session" }))
      .toBeInTheDocument();
    expect(screen.queryByLabelText("Dashboard access code")).not.toBeInTheDocument();
    expect(screen.getByText("Backend unavailable")).toBeInTheDocument();
  });

  it("revokes the server session on logout", async () => {
    const user = userEvent.setup();
    getDashboardSession.mockResolvedValue({
      success: true,
      expiresAt: "2026-11-09T00:00:00.000Z",
    });
    getDeviceStatus.mockResolvedValue(remoteConnected);

    render(<App />);
    await user.click(await screen.findByRole("button", { name: "Sign out" }));

    expect(await screen.findByLabelText("Dashboard access code")).toBeInTheDocument();
    expect(logoutDashboardSession).toHaveBeenCalledWith();
    expect(window.localStorage.length).toBe(0);
  });

  it("reports invalid dashboard credentials without exposing device status", async () => {
    const user = userEvent.setup();
    createDashboardSession.mockRejectedValue(
      new Error("Incorrect dashboard access code."),
    );
    render(<App />);

    await user.type(await screen.findByLabelText("Dashboard access code"), "bad-code");
    await user.click(screen.getByRole("button", { name: "Sign in" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Incorrect dashboard access code.",
    );
    expect(screen.getByText("Sign in to check device status")).toBeInTheDocument();
  });

  it("keeps local Wi-Fi provisioning available without dashboard authentication", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(await screen.findByRole("button", { name: "Device setup" }));
    expect(
      await screen.findByRole("heading", { name: "Wi-Fi configuration" }),
    ).toBeInTheDocument();

    await user.type(screen.getByLabelText("Wi-Fi network name (SSID)"), "Home WiFi");
    await user.type(screen.getByLabelText("Wi-Fi password"), "password123");
    await user.click(screen.getByRole("button", { name: "Connect to Wi-Fi" }));

    await waitFor(() =>
      expect(connectWiFi).toHaveBeenCalledWith("Home WiFi", "password123"),
    );
    expect(await screen.findByText(/connection is in progress/)).toBeInTheDocument();
  });
});
