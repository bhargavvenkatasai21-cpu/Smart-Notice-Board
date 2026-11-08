import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import SendNotice from "./SendNotice.jsx";

const connectedProps = {
  backendOnline: true,
  deviceError: "",
  deviceStatus: {
    connected: true,
    websocketConnected: true,
    lastSeenAt: "2026-11-08T10:00:00.000Z",
  },
  latestNotice: null,
  onSendNotice: vi.fn().mockResolvedValue({
    success: true,
    delivered: true,
    message: "ESP32 acknowledged the notice command.",
  }),
};

describe("SendNotice", () => {
  it("limits notices to 200 characters and shows the live counter", () => {
    render(<SendNotice {...connectedProps} />);

    expect(screen.getByLabelText("Notice text")).toHaveAttribute(
      "maxLength",
      "200",
    );
    expect(screen.getByText("0/200")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send Notice" })).toBeDisabled();
  });

  it("validates an empty message", () => {
    render(<SendNotice {...connectedProps} />);
    fireEvent.submit(screen.getByLabelText("Notice text").closest("form"));

    expect(screen.getByText("Enter a notice before sending.")).toBeInTheDocument();
    expect(connectedProps.onSendNotice).not.toHaveBeenCalled();
  });

  it("reports success only after the backend returns an acknowledged delivery", async () => {
    const user = userEvent.setup();
    const onSendNotice = vi.fn().mockResolvedValue({
      success: true,
      delivered: true,
      message: "ESP32 acknowledged the notice command.",
    });
    render(<SendNotice {...connectedProps} onSendNotice={onSendNotice} />);

    await user.type(screen.getByLabelText("Notice text"), "Meeting at 10");
    await user.click(screen.getByRole("button", { name: "Send Notice" }));

    expect(
      await screen.findByText("ESP32 acknowledged the notice command."),
    ).toBeInTheDocument();
    expect(onSendNotice).toHaveBeenCalledWith("Meeting at 10");
  });

  it("does not submit when disconnected and explains backend failures", async () => {
    const user = userEvent.setup();
    const onSendNotice = vi.fn().mockRejectedValue(new Error("ESP32 is offline."));
    render(<SendNotice {...connectedProps} onSendNotice={onSendNotice} />);

    await user.type(screen.getByLabelText("Notice text"), "Meeting at 10");
    await user.click(screen.getByRole("button", { name: "Send Notice" }));
    expect(await screen.findByText("ESP32 is offline.")).toBeInTheDocument();

    render(
      <SendNotice
        {...connectedProps}
        backendOnline={true}
        deviceStatus={{ connected: false }}
      />,
    );
    expect(
      screen.getByText(/ESP32 is disconnected/),
    ).toBeInTheDocument();
  });

  it("prevents duplicate submissions while a notice is processing", async () => {
    const user = userEvent.setup();
    let resolveSend;
    const onSendNotice = vi.fn(
      () =>
        new Promise((resolve) => {
          resolveSend = resolve;
        }),
    );
    render(<SendNotice {...connectedProps} onSendNotice={onSendNotice} />);

    await user.type(screen.getByLabelText("Notice text"), "Meeting at 10");
    await user.click(screen.getByRole("button", { name: "Send Notice" }));
    expect(screen.getByRole("button", { name: /Sending/ })).toBeDisabled();
    expect(onSendNotice).toHaveBeenCalledTimes(1);

    resolveSend({ success: true, delivered: true, message: "Acknowledged" });
    expect(await screen.findByText("Acknowledged")).toBeInTheDocument();
  });
});
