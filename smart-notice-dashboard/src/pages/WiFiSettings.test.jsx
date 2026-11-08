import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import WiFiSettings from "./WiFiSettings.jsx";

function renderSettings(overrides = {}) {
  const props = {
    wifiStatus: {
      connected: false,
      connecting: false,
      ssid: "",
      ip: "",
      apIp: "192.168.4.1",
      savedCredentials: false,
      connectionError: "",
    },
    statusError: "",
    statusLoaded: true,
    connectionFeedback: null,
    deviceAddress: "http://192.168.4.1",
    onConnect: vi.fn().mockResolvedValue({
      message: "Wi-Fi credentials saved; connection is in progress",
    }),
    onDisconnect: vi.fn().mockResolvedValue({
      message: "Disconnecting",
      reconnectAddress: "http://192.168.4.1",
    }),
    onReconnect: vi.fn().mockResolvedValue({
      message: "Reconnecting",
    }),
    onSaveDeviceAddress: vi.fn().mockResolvedValue({
      message: "Device found",
      address: "http://192.168.4.2",
    }),
    onDiscoverDevice: vi.fn().mockResolvedValue({
      message: "Device found",
    }),
    ...overrides,
  };
  return { ...render(<WiFiSettings {...props} />), props };
}

describe("WiFiSettings", () => {
  it("explains the access-point provisioning and router handoff", () => {
    renderSettings();
    expect(screen.getByText("SmartNoticeBoard")).toBeInTheDocument();
    expect(screen.getByText("12345678")).toBeInTheDocument();
    expect(
      screen.getByText(/The browser cannot switch networks for you/),
    ).toBeInTheDocument();
  });

  it("validates an empty SSID and an invalid password", async () => {
    const user = userEvent.setup();
    const { props } = renderSettings();

    await user.click(screen.getByRole("button", { name: "Connect to Wi-Fi" }));
    expect(screen.getByText("Enter a Wi-Fi network name.")).toBeInTheDocument();
    expect(props.onConnect).not.toHaveBeenCalled();

    await user.type(screen.getByLabelText("Wi-Fi network name (SSID)"), "Home");
    await user.type(screen.getByLabelText("Wi-Fi password"), "short");
    await user.click(screen.getByRole("button", { name: "Connect to Wi-Fi" }));
    expect(
      screen.getByText(/between 8 and 63 characters/),
    ).toBeInTheDocument();
    expect(props.onConnect).not.toHaveBeenCalled();
  });

  it("shows a bounded request loading state and reports accepted credentials", async () => {
    const user = userEvent.setup();
    let resolveConnect;
    const onConnect = vi.fn(
      () =>
        new Promise((resolve) => {
          resolveConnect = resolve;
        }),
    );
    renderSettings({ onConnect });

    await user.type(screen.getByLabelText("Wi-Fi network name (SSID)"), "Home");
    await user.type(
      screen.getByLabelText("Wi-Fi password"),
      "password123",
    );
    await user.click(screen.getByRole("button", { name: "Connect to Wi-Fi" }));

    expect(
      screen.getByRole("button", { name: /Connecting/ }),
    ).toBeDisabled();
    resolveConnect({ message: "Credentials saved; connection is in progress" });

    expect(
      await screen.findByText("Credentials saved; connection is in progress"),
    ).toBeInTheDocument();
    expect(onConnect).toHaveBeenCalledWith("Home", "password123");
    expect(screen.getByRole("button", { name: "Connect to Wi-Fi" })).toBeEnabled();
  });

  it("displays dynamic connection details and firmware errors", () => {
    renderSettings({
      wifiStatus: {
        connected: true,
        connecting: false,
        ssid: "Home WiFi",
        ip: "192.168.1.105",
        apIp: "192.168.4.1",
        savedCredentials: true,
        connectionError: "Router rejected the password",
      },
    });

    expect(screen.getByText("Connected")).toBeInTheDocument();
    expect(screen.getByText("Home WiFi")).toBeInTheDocument();
    expect(screen.getAllByText("192.168.1.105").length).toBeGreaterThan(0);
    expect(screen.getByText("Saved on board")).toBeInTheDocument();
    expect(screen.getByText("Router rejected the password")).toBeInTheDocument();
  });

  it("runs discover, disconnect, and reconnect controls", async () => {
    const user = userEvent.setup();
    const { props } = renderSettings({
      wifiStatus: {
        connected: true,
        connecting: false,
        ssid: "Home",
        ip: "192.168.1.105",
        apIp: "192.168.4.1",
        savedCredentials: true,
        connectionError: "",
      },
    });

    await user.click(screen.getByRole("button", { name: "Discover / refresh device" }));
    expect(props.onDiscoverDevice).toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Disconnect" }));
    await waitFor(() => expect(props.onDisconnect).toHaveBeenCalled());

    await user.click(screen.getByRole("button", { name: "Reconnect" }));
    await waitFor(() => expect(props.onReconnect).toHaveBeenCalled());
    expect(screen.getByText("Reconnecting")).toBeInTheDocument();
  });

  it("shows reconnect failures clearly", async () => {
    const user = userEvent.setup();
    const { props } = renderSettings({
      onReconnect: vi.fn().mockRejectedValue(new Error("No saved network")),
    });

    await user.click(screen.getByRole("button", { name: "Reconnect" }));
    expect(await screen.findByText("No saved network")).toBeInTheDocument();
    expect(props.onReconnect).toHaveBeenCalled();
  });

  it("shows the saving state and uses a validated manual address", async () => {
    const user = userEvent.setup();
    const { props } = renderSettings();
    const addressField = screen.getByLabelText("ESP32 address (advanced override)");

    await user.clear(addressField);
    await user.type(addressField, "192.168.4.1");
    await user.click(
      screen.getByRole("button", { name: "Save address and check" }),
    );

    await waitFor(() =>
      expect(props.onSaveDeviceAddress).toHaveBeenCalledWith("192.168.4.1"),
    );
    expect(await screen.findByText("Device found")).toBeInTheDocument();
  });

  it("shows connection progress without enabling another connection attempt", () => {
    renderSettings({
      wifiStatus: {
        connected: false,
        connecting: true,
        ssid: "Home",
        ip: "",
        apIp: "192.168.4.1",
        savedCredentials: true,
        connectionError: "",
      },
    });

    expect(screen.getByText("Connecting")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reconnect" })).toBeDisabled();
  });
});
