import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { App } from "./main";

class MockWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  static instances: MockWebSocket[] = [];

  readonly url: string;
  readyState = MockWebSocket.CONNECTING;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
  }

  open() {
    this.readyState = MockWebSocket.OPEN;
    this.onopen?.();
  }

  message(body: object) {
    this.onmessage?.({ data: JSON.stringify(body) });
  }

  send(body: string) {
    this.sent.push(body);
  }

  close() {
    if (this.readyState === MockWebSocket.CLOSED) {
      return;
    }
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.();
  }
}

let authResponse: Response;

function jsonResponse(body: object, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}

function installFetchMock() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/auth/")) return authResponse.clone();
      if (url.endsWith("/health")) return jsonResponse({ status: "ok", core_host: "127.0.0.1", core_port: 5555 });
      if (url.includes("/core-stats")) {
        return jsonResponse({
          current_connections: 1,
          registered_clients: 1,
          total_connections: 1,
          channels: 0,
          channel_messages: 0,
          direct_messages: 0,
          malformed_frames: 0,
          queue_disconnects: 0,
          max_queue_bytes: 65536
        });
      }
      if (url.includes("/stats")) {
        return jsonResponse({ users: 1, channels: 0, memberships: 0, messages: 0, channel_messages: 0, direct_messages: 0 });
      }
      if (url.includes("/db/channels")) return jsonResponse({ channels: [] });
      return jsonResponse({ messages: [] });
    })
  );
}

async function login() {
  render(<App />);
  fireEvent.change(screen.getByLabelText("Password"), { target: { value: "correct-horse-battery" } });
  fireEvent.click(screen.getByRole("button", { name: "Login" }));
  await screen.findByText("alice");
}

describe("authenticated session lifecycle", () => {
  beforeEach(() => {
    MockWebSocket.instances = [];
    authResponse = jsonResponse({ access_token: "test-token", token_type: "bearer" });
    installFetchMock();
    vi.stubGlobal("WebSocket", MockWebSocket);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("connects after login and shows only authenticated navigation", async () => {
    await login();

    expect(MockWebSocket.instances).toHaveLength(1);
    expect(MockWebSocket.instances[0].url).toContain("token=test-token");
    expect(screen.getByText("Signed in as")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Logout" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Login" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Register" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Connect/ })).not.toBeInTheDocument();
    expect(screen.getByLabelText("Messaging")).toBeInTheDocument();
  });

  it("reconnects after an unexpected close", async () => {
    await login();
    const firstSocket = MockWebSocket.instances[0];
    act(() => {
      firstSocket.open();
      firstSocket.message({ type: "ok", message: "joined general" });
    });
    vi.useFakeTimers();

    act(() => firstSocket.close());
    expect(screen.getByText("Connection lost. Reconnecting…")).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(1000));

    expect(MockWebSocket.instances).toHaveLength(2);
    const secondSocket = MockWebSocket.instances[1];
    act(() => {
      secondSocket.open();
      secondSocket.message({ type: "ready", username: "alice" });
    });
    expect(secondSocket.sent).toContain(JSON.stringify({ type: "join", channel: "general" }));
  });

  it("clears authenticated data and disables reconnect on logout", async () => {
    await login();
    const socket = MockWebSocket.instances[0];
    act(() => {
      socket.open();
      socket.message({ type: "system", message: "private session event" });
    });
    vi.useFakeTimers();

    fireEvent.click(screen.getByRole("button", { name: "Logout" }));
    act(() => vi.advanceTimersByTime(20_000));

    expect(socket.sent).toContain(JSON.stringify({ type: "quit" }));
    expect(socket.readyState).toBe(MockWebSocket.CLOSED);
    expect(MockWebSocket.instances).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Login" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Register" })).toBeInTheDocument();
    expect(screen.queryByLabelText("Messaging")).not.toBeInTheDocument();
    expect(screen.queryByText("private session event")).not.toBeInTheDocument();
  });
});

describe("user-friendly errors", () => {
  beforeEach(() => {
    MockWebSocket.instances = [];
    authResponse = jsonResponse({ access_token: "test-token", token_type: "bearer" });
    installFetchMock();
    vi.stubGlobal("WebSocket", MockWebSocket);
  });

  afterEach(() => vi.unstubAllGlobals());

  it("converts technical password validation responses", async () => {
    authResponse = jsonResponse(
      {
        detail: [
          {
            type: "string_too_short",
            loc: ["body", "password"],
            msg: "String should have at least 8 characters"
          }
        ]
      },
      422
    );
    render(<App />);
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "short" } });
    fireEvent.click(screen.getByRole("button", { name: "Login" }));

    expect(await screen.findByText("Password must be at least 8 characters.")).toBeInTheDocument();
  });

  it("shows a clear error for invalid and unknown DM recipients", async () => {
    await login();
    const socket = MockWebSocket.instances[0];
    act(() => socket.open());

    fireEvent.change(screen.getByLabelText("To"), { target: { value: "not a user!" } });
    fireEvent.change(screen.getByLabelText("Message"), { target: { value: "hello" } });
    fireEvent.click(screen.getByRole("button", { name: "Send DM" }));
    expect(screen.getByText("User not found. Check the username and try again.")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("To"), { target: { value: "missing-user" } });
    fireEvent.click(screen.getByRole("button", { name: "Send DM" }));
    act(() => socket.message({ type: "error", message: "user not found" }));
    await waitFor(() => expect(screen.getAllByText("User not found. Check the username and try again.").length).toBeGreaterThan(0));
  });
});
