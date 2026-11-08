import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import SendNotice from "./SendNotice.jsx";
import { sendNotice } from "../services/esp32Service.js";

vi.mock("../services/esp32Service.js", () => ({
  sendNotice: vi.fn(),
}));

const connectedProps = {
  wifiStatus: {
    connected: true,
    connecting: false,
    ssid: "Home WiFi",
    ip: "192.168.1.105",
    apIp: "192.168.4.1",
  },
  statusError: "",
  statusLoaded: true,
  deviceAddress: "http://192.168.4.1",
  refreshStatus: vi.fn().mockResolvedValue({
    connected: true,
    ip: "192.168.1.105",
  }),
  onNavigate: vi.fn(),
};

describe("SendNotice", () => {
  beforeEach(() => {
    sendNotice.mockReset();
  });

  it("shows the discovered device IP and limits notices to 200 characters", () => {
    render(<SendNotice {...connectedProps} />);

    expect(screen.getAllByText("192.168.1.105").length).toBeGreaterThan(0);
    expect(screen.getByLabelText("Notice text")).toHaveAttribute(
      "maxLength",
      "200",
    );
    expect(screen.getByRole("button", { name: "Send Notice" })).toBeDisabled();
  });

  it("validates an empty message", () => {
    render(<SendNotice {...connectedProps} />);
    fireEvent.submit(screen.getByLabelText("Notice text").closest("form"));

    expect(screen.getByText("Enter a notice before sending.")).toBeInTheDocument();
    expect(sendNotice).not.toHaveBeenCalled();
  });

  it("checks current status and reports successful delivery", async () => {
    const user = userEvent.setup();
    sendNotice.mockResolvedValue({ message: "Notice displayed on the LCD" });
    render(<SendNotice {...connectedProps} />);

    await user.type(screen.getByLabelText("Notice text"), "Meeting at 10");
    await user.click(screen.getByRole("button", { name: "Send Notice" }));

    expect(
      await screen.findByText("Notice displayed on the LCD"),
    ).toBeInTheDocument();
    expect(connectedProps.refreshStatus).toHaveBeenCalled();
    expect(sendNotice).toHaveBeenCalledWith("Meeting at 10");
  });

  it("does not submit when disconnected and explains send failures", async () => {
    const user = userEvent.setup();
    sendNotice.mockRejectedValue(new Error("ESP32 request timed out"));
    render(
      <SendNotice
        {...connectedProps}
        refreshStatus={vi.fn().mockResolvedValue({ connected: true })}
      />,
    );

    await user.type(screen.getByLabelText("Notice text"), "Meeting at 10");
    await user.click(screen.getByRole("button", { name: "Send Notice" }));
    expect(
      await screen.findByText("ESP32 request timed out"),
    ).toBeInTheDocument();
  });

  it("blocks notice delivery if status confirms the board is disconnected", async () => {
    const user = userEvent.setup();
    render(
      <SendNotice
        {...connectedProps}
        refreshStatus={vi.fn().mockResolvedValue({ connected: false })}
      />,
    );
    await user.type(screen.getByLabelText("Notice text"), "Meeting at 10");
    await user.click(screen.getByRole("button", { name: "Send Notice" }));

    expect(
      await screen.findByText("The ESP32 is disconnected. Reconnect before sending a notice."),
    ).toBeInTheDocument();
    expect(sendNotice).not.toHaveBeenCalled();
  });
});
