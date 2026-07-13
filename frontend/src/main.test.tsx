import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { App, SESSION_STORAGE_KEY } from "./main";

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
let statsResponse: Response;
let healthUnavailable: boolean;
let authUnavailable: boolean;

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
      if (url.endsWith("/health") && healthUnavailable) throw new TypeError("Failed to fetch");
      if (url.includes("/auth/") && authUnavailable) throw new TypeError("Failed to fetch");
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
        return statsResponse.clone();
      }
      if (url.includes("/db/channels")) return jsonResponse({ channels: [] });
      return jsonResponse({ messages: [] });
    })
  );
}

async function login() {
  render(<App />);
  fireEvent.change(await screen.findByLabelText("Password"), { target: { value: "correct-horse-battery" } });
  fireEvent.click(screen.getByRole("button", { name: "Login" }));
  await screen.findByText("alice");
}

describe("authenticated session lifecycle", () => {
  beforeEach(() => {
    window.localStorage.clear();
    MockWebSocket.instances = [];
    authResponse = jsonResponse({ access_token: "test-token", token_type: "bearer" });
    statsResponse = jsonResponse({ users: 1, channels: 0, memberships: 0, messages: 0, channel_messages: 0, direct_messages: 0 });
    healthUnavailable = false;
    authUnavailable = false;
    installFetchMock();
    vi.stubGlobal("WebSocket", MockWebSocket);
  });

  afterEach(() => {
    vi.useRealTimers();
    window.localStorage.clear();
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
    expect(screen.getByRole("textbox", { name: "Message or command" })).toBeInTheDocument();
  });

  it("updates empty guidance after connecting and joining a channel", async () => {
    await login();
    const socket = MockWebSocket.instances[0];

    expect(screen.getByText("Connect to list channels")).toBeInTheDocument();
    expect(screen.getByText("Connect to see active users")).toBeInTheDocument();

    act(() => socket.open());
    expect(screen.getByText("Loading live channels…")).toBeInTheDocument();
    expect(socket.sent).toContain(JSON.stringify({ type: "list" }));
    expect(screen.getByText("Join a channel to see participants")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Refresh" })).toHaveLength(2);
    expect(screen.getAllByRole("button", { name: "Refresh" })[1]).toBeDisabled();

    act(() => socket.message({ type: "channels", channels: [] }));
    expect(screen.getByText("No live channels yet")).toBeInTheDocument();

    act(() => socket.message({ type: "ok", message: "joined general" }));
    expect(screen.getByText("Loading participants…")).toBeInTheDocument();
    expect(socket.sent).toContain(JSON.stringify({ type: "who" }));
    expect(screen.getAllByRole("button", { name: "Refresh" })[1]).toBeEnabled();

    act(() => socket.message({ type: "who", users: [] }));
    expect(screen.getByText("No active participants")).toBeInTheDocument();
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
    expect(window.localStorage.getItem(SESSION_STORAGE_KEY)).toBeNull();
  });
});

describe("logged-out startup", () => {
  beforeEach(() => {
    window.localStorage.clear();
    MockWebSocket.instances = [];
    authResponse = jsonResponse({ access_token: "test-token", token_type: "bearer" });
    statsResponse = jsonResponse({ users: 1, channels: 0, memberships: 0, messages: 0, channel_messages: 0, direct_messages: 0 });
    healthUnavailable = false;
    authUnavailable = false;
    installFetchMock();
    vi.stubGlobal("WebSocket", MockWebSocket);
  });

  afterEach(() => {
    vi.useRealTimers();
    window.localStorage.clear();
    vi.unstubAllGlobals();
  });

  it("keeps sign-in unavailable until the real health check succeeds", async () => {
    let resolveHealth!: (response: Response) => void;
    const healthResponse = new Promise<Response>((resolve) => {
      resolveHealth = resolve;
    });
    vi.mocked(fetch).mockImplementationOnce(() => healthResponse);

    render(<App />);

    expect(screen.getByRole("status")).toHaveTextContent("Checking ChannelWire.");
    expect(screen.getByRole("progressbar", { name: "Checking gateway readiness" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Login" })).not.toBeInTheDocument();

    await act(async () => {
      resolveHealth(jsonResponse({ status: "ok", core_host: "127.0.0.1", core_port: 5555 }));
    });

    expect(await screen.findByRole("button", { name: "Login" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Register" })).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("ChannelWire is ready.");
  });

  it("uses a bounded failure path and retries the readiness check on demand", async () => {
    vi.useFakeTimers();
    const timedOutFetch = vi.mocked(fetch);
    timedOutFetch.mockImplementation(() => new Promise<Response>(() => undefined));
    render(<App />);

    expect(screen.getByRole("status")).toHaveTextContent("Checking ChannelWire.");
    await act(async () => vi.runAllTimersAsync());

    expect(screen.getByRole("alert")).toHaveTextContent("ChannelWire isn’t ready");
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
    expect(timedOutFetch).toHaveBeenCalledTimes(6);
    expect(screen.queryByText("Failed to fetch")).not.toBeInTheDocument();
    expect(MockWebSocket.instances).toHaveLength(0);

    let resolveRetry!: (response: Response) => void;
    const retryResponse = new Promise<Response>((resolve) => {
      resolveRetry = resolve;
    });
    const retryFetch = vi.fn(() => retryResponse);
    vi.stubGlobal("fetch", retryFetch);

    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(screen.getByRole("status")).toHaveTextContent("Checking ChannelWire.");
    expect(screen.queryByRole("button", { name: "Try again" })).not.toBeInTheDocument();

    await act(async () => {
      resolveRetry(jsonResponse({ status: "ok", core_host: "127.0.0.1", core_port: 5555 }));
    });

    expect(screen.getByRole("button", { name: "Login" })).toBeInTheDocument();
    expect(retryFetch).toHaveBeenCalledTimes(1);
  });

  it("aborts an in-flight readiness request when unmounted", async () => {
    const requestSignal: { current: AbortSignal | null } = { current: null };
    vi.mocked(fetch).mockImplementationOnce((_input, init) => {
      requestSignal.current = init?.signal ?? null;
      return new Promise<Response>(() => undefined);
    });

    const { unmount } = render(<App />);
    await waitFor(() => expect(requestSignal.current).not.toBeNull());
    expect(requestSignal.current?.aborted).toBe(false);

    unmount();

    expect(requestSignal.current?.aborted).toBe(true);
  });

  it("clears an invalid stored session without connecting", async () => {
    const payload = btoa(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 }))
      .replace(/=/g, "")
      .replace(/\+/g, "-")
      .replace(/\//g, "_");
    window.localStorage.setItem(
      SESSION_STORAGE_KEY,
      JSON.stringify({ token: `header.${payload}.signature`, username: "alice" })
    );
    statsResponse = jsonResponse({ detail: "invalid token" }, 401);

    render(<App />);

    await screen.findByRole("button", { name: "Login" });
    expect(window.localStorage.getItem(SESSION_STORAGE_KEY)).toBeNull();
    expect(MockWebSocket.instances).toHaveLength(0);
    expect(screen.queryByText("Failed to fetch")).not.toBeInTheDocument();
  });

  it("clears an expired stored session before making authenticated requests", async () => {
    const payload = btoa(JSON.stringify({ exp: Math.floor(Date.now() / 1000) - 60 }))
      .replace(/=/g, "")
      .replace(/\+/g, "-")
      .replace(/\//g, "_");
    window.localStorage.setItem(
      SESSION_STORAGE_KEY,
      JSON.stringify({ token: `header.${payload}.signature`, username: "alice" })
    );

    render(<App />);

    expect(await screen.findByRole("button", { name: "Login" })).toBeInTheDocument();
    expect(window.localStorage.getItem(SESSION_STORAGE_KEY)).toBeNull();
    expect(MockWebSocket.instances).toHaveLength(0);
    expect(vi.mocked(fetch).mock.calls.some(([input]) => String(input).includes("/stats"))).toBe(false);
  });

  it.each(["Login", "Register"] as const)("shows a friendly error when an active %s cannot reach the backend", async (action) => {
    authUnavailable = true;
    render(<App />);
    fireEvent.change(await screen.findByLabelText("Password"), { target: { value: "correct-horse-battery" } });
    fireEvent.click(screen.getByRole("button", { name: action }));

    expect(await screen.findByText("Unable to reach the server. Please try again.")).toBeInTheDocument();
    expect(screen.queryByText("Failed to fetch")).not.toBeInTheDocument();
    expect(MockWebSocket.instances).toHaveLength(0);
  });
});

describe("user-friendly errors", () => {
  beforeEach(() => {
    window.localStorage.clear();
    MockWebSocket.instances = [];
    authResponse = jsonResponse({ access_token: "test-token", token_type: "bearer" });
    statsResponse = jsonResponse({ users: 1, channels: 0, memberships: 0, messages: 0, channel_messages: 0, direct_messages: 0 });
    healthUnavailable = false;
    authUnavailable = false;
    installFetchMock();
    vi.stubGlobal("WebSocket", MockWebSocket);
  });

  afterEach(() => {
    vi.useRealTimers();
    window.localStorage.clear();
    vi.unstubAllGlobals();
  });

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
    fireEvent.change(await screen.findByLabelText("Password"), { target: { value: "short" } });
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

  it("keeps DM validation reachable after connecting", async () => {
    await login();
    const socket = MockWebSocket.instances[0];
    act(() => socket.open());

    const sendButton = screen.getByRole("button", { name: "Send DM" });
    expect(sendButton).toBeEnabled();
    fireEvent.click(sendButton);

    expect(screen.getByText("Enter a username.")).toBeInTheDocument();
  });

  it("clears a recovered health error without clearing an interaction error", async () => {
    render(<App />);
    fireEvent.change(await screen.findByLabelText("Password"), { target: { value: "correct-horse-battery" } });
    fireEvent.click(screen.getByRole("button", { name: "Login" }));
    await screen.findByText("alice");
    const socket = MockWebSocket.instances[0];
    act(() => socket.open());

    healthUnavailable = true;
    fireEvent.click(screen.getAllByRole("button", { name: "Refresh" })[0]);
    expect(await screen.findByText("Gateway unavailable. Check that the API is running, then refresh.")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Send DM" }));
    expect(screen.getByText("Enter a username.")).toBeInTheDocument();

    healthUnavailable = false;
    fireEvent.click(screen.getAllByRole("button", { name: "Refresh" })[0]);

    await waitFor(() => expect(screen.getByText("ok")).toBeInTheDocument());
    expect(screen.getByText("Enter a username.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Dismiss error" }));
    expect(screen.queryByText("Gateway unavailable. Check that the API is running, then refresh.")).not.toBeInTheDocument();
  });
});
