import React, { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  Activity,
  AlertCircle,
  Circle,
  HelpCircle,
  Hash,
  History,
  LogIn,
  LogOut,
  MessagesSquare,
  RefreshCw,
  Send,
  Trash2,
  Users,
  X
} from "lucide-react";
import "./styles.css";

type GatewayEvent =
  | { type: "ready"; username: string }
  | { type: "ok"; message: string }
  | { type: "error"; message: string }
  | { type: "system"; message: string }
  | { type: "chat"; channel: string; sender: string; text: string }
  | { type: "dm"; sender: string; text: string }
  | { type: "who"; users: string[] }
  | { type: "channels"; channels: string[] };

type ChatLine = {
  id: number;
  kind: "chat" | "dm" | "system" | "status" | "error";
  channel?: string;
  sender?: string;
  text: string;
};

type Health = {
  status: string;
  core_host: string;
  core_port: number;
};

type BackendReadiness = "checking" | "ready" | "failed";

type PlatformStats = {
  users: number;
  channels: number;
  memberships: number;
  messages: number;
  channel_messages: number;
  direct_messages: number;
};

type CoreStats = {
  current_connections: number;
  registered_clients: number;
  total_connections: number;
  channels: number;
  channel_messages: number;
  direct_messages: number;
  malformed_frames: number;
  queue_disconnects: number;
  max_queue_bytes: number;
};

type PersistedChannel = {
  name: string;
  created_at: string;
};

type MonitorSample = {
  id: number;
  messages: number;
  queuePressure: number;
  malformedFrames: number;
};

const gatewayHttp = import.meta.env.VITE_GATEWAY_URL ?? "http://127.0.0.1:8000";
const gatewayWs = gatewayHttp.replace(/^http/, "ws");
const devTokenEnabled = import.meta.env.DEV || import.meta.env.VITE_ENABLE_DEV_TOKEN === "1";
const MESSAGE_LIMIT = 80;
const RECONNECT_MAX_DELAY_MS = 10_000;
const READINESS_MAX_ATTEMPTS = 6;
const READINESS_RETRY_DELAY_MS = 2_500;
const READINESS_REQUEST_TIMEOUT_MS = 3_000;
const GATEWAY_HEALTH_ERROR = "Gateway unavailable. Check that the API is running, then refresh.";
export const SESSION_STORAGE_KEY = "channelwire-session";
const HELP_TEXT = `Commands:
/help — view commands
/clear — clear visible messages
/join CHANNEL — join a channel
/switch CHANNEL — switch channels
/leave CHANNEL — leave a channel
/dm USER MESSAGE — send a direct message
/who — view channel participants
/list — view channels
/stats — update monitoring
/history — load channel history
/quit — sign out`;

type ValidationIssue = {
  type?: string;
  loc?: Array<string | number>;
  msg?: string;
};

type StoredSession = {
  token: string;
  username: string;
};

function clearStoredSession() {
  window.localStorage.removeItem(SESSION_STORAGE_KEY);
}

function readStoredSession(): StoredSession | null {
  try {
    const stored = window.localStorage.getItem(SESSION_STORAGE_KEY);
    if (!stored) return null;
    const session = JSON.parse(stored) as Partial<StoredSession>;
    if (typeof session.token !== "string" || typeof session.username !== "string" || !session.token || !session.username) {
      clearStoredSession();
      return null;
    }

    const encodedPayload = session.token.split(".")[1];
    if (!encodedPayload) {
      clearStoredSession();
      return null;
    }
    const normalizedPayload = encodedPayload.replace(/-/g, "+").replace(/_/g, "/");
    const paddedPayload = normalizedPayload.padEnd(Math.ceil(normalizedPayload.length / 4) * 4, "=");
    const payload = JSON.parse(atob(paddedPayload)) as { exp?: number };
    if (typeof payload.exp !== "number" || payload.exp <= Date.now() / 1000) {
      clearStoredSession();
      return null;
    }
    return { token: session.token, username: session.username };
  } catch {
    clearStoredSession();
    return null;
  }
}

export async function responseError(response: Response): Promise<string> {
  const fallback = "Something went wrong. Please try again.";
  let body: { detail?: string | ValidationIssue[] } | null = null;

  try {
    body = await response.clone().json();
  } catch {
    const text = (await response.text()).trim();
    return text || fallback;
  }

  if (typeof body?.detail === "string") {
    if (body.detail === "invalid username or password") {
      return "Username or password is incorrect.";
    }
    if (body.detail === "username already exists") {
      return "That username is already registered. Sign in or choose another.";
    }
    if (body.detail === "dev token disabled") {
      return "Developer sign-in is unavailable.";
    }
    if (["invalid token", "invalid token subject", "missing token"].includes(body.detail)) {
      return "Your session has expired. Sign in again.";
    }
    return body.detail;
  }

  const issue = Array.isArray(body?.detail) ? body.detail[0] : undefined;
  const field = issue?.loc?.at(-1);
  if (field === "password" && issue?.type === "string_too_short") {
    return "Password must be at least 8 characters.";
  }
  if (field === "username") {
    return "Enter a valid username using letters, numbers, periods, underscores, or hyphens.";
  }
  return fallback;
}

function friendlyGatewayError(message: string): string {
  if (message === "user not found") {
    return "User not found. Check the username and try again.";
  }
  if (message === "invalid direct message" || message === "dm requires to and text") {
    return "Couldn’t send the direct message. Check the username and message, then try again.";
  }
  if (message === "join a channel before sending") {
    return "Join a channel before sending a message.";
  }
  if (message === "join a channel before listing participants") {
    return "Join a channel to view participants.";
  }
  if (message === "message payload too large") {
    return "Message is too long. Shorten it and try again.";
  }
  if (message === "invalid username") {
    return "Enter a valid username using letters, numbers, periods, underscores, or hyphens.";
  }
  if (message === "username already in use") {
    return "That username is already in use.";
  }
  if (message === "invalid channel") {
    return "Enter a valid channel name.";
  }
  if (message === "too many channels") {
    return "Can’t create another channel. The channel limit has been reached.";
  }
  if (message === "join channel before switching") {
    return "Join a channel before switching channels.";
  }
  if (message === "not in channel") {
    return "You’re not in that channel.";
  }
  if (message === "WHO response too large") {
    return "Too many participants to display.";
  }
  if (message === "LIST response too large") {
    return "Too many channels to display.";
  }
  if (message === "stats response too large") {
    return "Monitoring data is too large to display.";
  }
  if (message === "send HELLO first") {
    return "Connection isn’t ready. Try again.";
  }
  if (message === "invalid message") {
    return "Couldn’t send the message. Check it and try again.";
  }
  if (message === "unknown message type") {
    return "This command isn’t supported.";
  }
  if (message === "malformed frame") {
    return "Received an invalid response. Try again.";
  }
  return message;
}

function friendlyGatewayMessage(message: string): string {
  const channelEvent = /^(joined|switched) (.+)$/.exec(message);
  if (channelEvent) {
    return channelEvent[1] === "joined" ? `Joined #${channelEvent[2]}.` : `Switched to #${channelEvent[2]}.`;
  }
  if (message === "left channel") {
    return "Left the channel.";
  }
  if (message === "direct message sent") {
    return "Direct message sent.";
  }
  return message;
}

function Sparkline({ values, className }: { values: number[]; className: string }) {
  const width = 160;
  const height = 42;
  const max = Math.max(1, ...values);
  const points =
    values.length === 0
      ? ""
      : values
          .map((value, index) => {
            const x = values.length === 1 ? width : (index / (values.length - 1)) * width;
            const y = height - (value / max) * (height - 4) - 2;
            return `${x.toFixed(1)},${y.toFixed(1)}`;
          })
          .join(" ");

  return (
    <svg className={`sparkline ${className}`} viewBox={`0 0 ${width} ${height}`} role="img" aria-hidden="true">
      <polyline points={points} />
    </svg>
  );
}

export function App() {
  const [initialSession] = useState(readStoredSession);
  const [username, setUsername] = useState(initialSession?.username ?? "alice");
  const [password, setPassword] = useState("");
  const [token, setToken] = useState(initialSession?.token ?? "");
  const [authenticatedUsername, setAuthenticatedUsername] = useState(initialSession?.username ?? "");
  const [channel, setChannel] = useState("general");
  const [activeChannel, setActiveChannel] = useState("");
  const [message, setMessage] = useState("");
  const [dmTo, setDmTo] = useState("");
  const [dmText, setDmText] = useState("");
  const [connected, setConnected] = useState(false);
  const [messages, setMessages] = useState<ChatLine[]>([]);
  const [users, setUsers] = useState<string[]>([]);
  const [usersLoaded, setUsersLoaded] = useState(false);
  const [channels, setChannels] = useState<string[]>([]);
  const [channelsLoaded, setChannelsLoaded] = useState(false);
  const [health, setHealth] = useState<Health | null>(null);
  const [platformStats, setPlatformStats] = useState<PlatformStats | null>(null);
  const [coreStats, setCoreStats] = useState<CoreStats | null>(null);
  const [monitorSamples, setMonitorSamples] = useState<MonitorSample[]>([]);
  const [persistedChannels, setPersistedChannels] = useState<PersistedChannel[]>([]);
  const [error, setError] = useState("");
  const [healthError, setHealthError] = useState("");
  const [backendReadiness, setBackendReadiness] = useState<BackendReadiness>("checking");
  const socketRef = useRef<WebSocket | null>(null);
  const tokenRef = useRef(initialSession?.token ?? "");
  const activeChannelRef = useRef("");
  const reconnectTimerRef = useRef<number | null>(null);
  const reconnectAttemptRef = useRef(0);
  const allowReconnectRef = useRef(Boolean(initialSession));
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const readinessRunRef = useRef(0);
  const readinessAbortRef = useRef<AbortController | null>(null);
  const readinessRequestTimerRef = useRef<number | null>(null);
  const readinessRetryTimerRef = useRef<number | null>(null);
  const restoredSessionStartedRef = useRef(false);

  const stats = useMemo(
    () => ({
      messages: messages.filter((item) => item.kind === "chat").length,
      direct: messages.filter((item) => item.kind === "dm").length,
      events: messages.length
    }),
    [messages]
  );
  const monitoring = useMemo(() => {
    const storedMessages = platformStats?.messages ?? 0;
    const channelMessages = platformStats?.channel_messages ?? 0;
    const directMessages = platformStats?.direct_messages ?? 0;
    const queueDrops = coreStats?.queue_disconnects ?? 0;
    const totalConnections = coreStats?.total_connections ?? 0;
    const queuePressure = totalConnections > 0 ? Math.min(100, (queueDrops / totalConnections) * 100) : 0;
    const channelShare = storedMessages > 0 ? Math.min(100, (channelMessages / storedMessages) * 100) : 0;
    const directShare = storedMessages > 0 ? Math.min(100, (directMessages / storedMessages) * 100) : 0;

    return {
      queuePressure,
      channelShare,
      directShare,
      malformedFrames: coreStats?.malformed_frames ?? 0,
      totalConnections
    };
  }, [coreStats, platformStats]);
  const monitorSeries = useMemo(
    () => ({
      messages: monitorSamples.map((item) => item.messages),
      queuePressure: monitorSamples.map((item) => item.queuePressure),
      malformedFrames: monitorSamples.map((item) => item.malformedFrames)
    }),
    [monitorSamples]
  );

  function pushLine(line: Omit<ChatLine, "id">) {
    setMessages((current) => [...current.slice(-(MESSAGE_LIMIT - 1)), { ...line, id: Date.now() + Math.random() }]);
  }

  function replaceMessages(nextMessages: ChatLine[]) {
    setMessages(nextMessages.slice(-MESSAGE_LIMIT));
  }

  function clearMessages() {
    setMessages([]);
    setError("");
  }

  function showHelp() {
    pushLine({ kind: "system", text: HELP_TEXT });
  }

  function recordMonitorSample(platform: PlatformStats, core: CoreStats) {
    const queuePressure =
      core.total_connections > 0 ? Math.min(100, (core.queue_disconnects / core.total_connections) * 100) : 0;
    setMonitorSamples((current) => [
      ...current.slice(-29),
      {
        id: Date.now(),
        messages: platform.messages,
        queuePressure,
        malformedFrames: core.malformed_frames
      }
    ]);
  }

  function clearReadinessTimers() {
    if (readinessRequestTimerRef.current !== null) {
      window.clearTimeout(readinessRequestTimerRef.current);
      readinessRequestTimerRef.current = null;
    }
    if (readinessRetryTimerRef.current !== null) {
      window.clearTimeout(readinessRetryTimerRef.current);
      readinessRetryTimerRef.current = null;
    }
  }

  function cancelReadinessCheck() {
    readinessRunRef.current += 1;
    readinessAbortRef.current?.abort();
    readinessAbortRef.current = null;
    clearReadinessTimers();
  }

  function startReadinessCheck() {
    cancelReadinessCheck();
    const run = readinessRunRef.current;
    setBackendReadiness("checking");
    setHealth(null);
    setHealthError("");

    const check = async (attempt: number) => {
      const controller = new AbortController();
      readinessAbortRef.current = controller;

      try {
        const response = await Promise.race<Response>([
          fetch(`${gatewayHttp}/health`, { cache: "no-store", signal: controller.signal }),
          new Promise<Response>((_, reject) => {
            readinessRequestTimerRef.current = window.setTimeout(() => {
              controller.abort();
              reject(new Error("gateway readiness check timed out"));
            }, READINESS_REQUEST_TIMEOUT_MS);
          })
        ]);
        if (!response.ok) {
          throw new Error("gateway readiness check failed");
        }

        const nextHealth = (await response.json()) as Partial<Health>;
        if (
          nextHealth.status !== "ok" ||
          typeof nextHealth.core_host !== "string" ||
          typeof nextHealth.core_port !== "number"
        ) {
          throw new Error("gateway readiness response was invalid");
        }
        if (readinessRunRef.current !== run) return;

        setHealth(nextHealth as Health);
        setBackendReadiness("ready");
      } catch {
        if (readinessRunRef.current !== run) return;
        if (attempt >= READINESS_MAX_ATTEMPTS) {
          setHealth(null);
          setBackendReadiness("failed");
          return;
        }

        readinessRetryTimerRef.current = window.setTimeout(() => {
          readinessRetryTimerRef.current = null;
          void check(attempt + 1);
        }, READINESS_RETRY_DELAY_MS);
      } finally {
        if (readinessRequestTimerRef.current !== null) {
          window.clearTimeout(readinessRequestTimerRef.current);
          readinessRequestTimerRef.current = null;
        }
        if (readinessAbortRef.current === controller) {
          readinessAbortRef.current = null;
        }
      }
    };

    void check(1);
  }

  async function refreshHealth() {
    try {
      const response = await fetch(`${gatewayHttp}/health`);
      if (!response.ok) {
        throw new Error("gateway health check failed");
      }
      setHealth(await response.json());
      setHealthError("");
    } catch {
      setHealth(null);
      setHealthError(GATEWAY_HEALTH_ERROR);
    }
  }

  async function refreshStats(accessToken = token): Promise<boolean> {
    if (!accessToken) {
      return false;
    }
    let nextPlatformStats: PlatformStats | null = null;
    let nextCoreStats: CoreStats | null = null;

    const response = await fetch(`${gatewayHttp}/stats?token=${encodeURIComponent(accessToken)}`);
    if (response.status === 401 || response.status === 403) {
      logout();
      return false;
    }
    if (!response.ok) return false;
    if (response.ok) {
      nextPlatformStats = await response.json();
      if (tokenRef.current !== accessToken) return false;
      setPlatformStats(nextPlatformStats);
    }

    const coreResponse = await fetch(`${gatewayHttp}/core-stats?token=${encodeURIComponent(accessToken)}`);
    if (coreResponse.ok) {
      nextCoreStats = await coreResponse.json();
      if (tokenRef.current !== accessToken) return false;
      setCoreStats(nextCoreStats);
    }

    if (nextPlatformStats && nextCoreStats) {
      recordMonitorSample(nextPlatformStats, nextCoreStats);
    }

    const channelsResponse = await fetch(`${gatewayHttp}/db/channels?token=${encodeURIComponent(accessToken)}`);
    if (channelsResponse.ok) {
      const body = await channelsResponse.json();
      if (tokenRef.current !== accessToken) return false;
      setPersistedChannels(body.channels);
    }
    return true;
  }

  async function createToken() {
    let response: Response;
    try {
      response = await fetch(`${gatewayHttp}/auth/dev-token`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username })
      });
    } catch {
      setError("Can’t reach ChannelWire. Try again.");
      return "";
    }
    if (!response.ok) {
      setError(await responseError(response));
      return "";
    }
    const body = await response.json();
    startSession(body.access_token, username);
    await refreshStats(body.access_token).catch(() => false);
    if (tokenRef.current === body.access_token) {
      connect(body.access_token);
    }
    return body.access_token as string;
  }

  async function authenticate(path: "register" | "login") {
    setError("");
    let response: Response;
    try {
      response = await fetch(`${gatewayHttp}/auth/${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username, password })
      });
    } catch {
      setError("Can’t reach ChannelWire. Try again.");
      return "";
    }
    if (!response.ok) {
      setError(await responseError(response));
      return "";
    }
    const body = await response.json();
    startSession(body.access_token, username);
    await refreshStats(body.access_token).catch(() => false);
    if (tokenRef.current === body.access_token) {
      connect(body.access_token);
    }
    pushLine({
      kind: "status",
      text: path === "register" ? `Account created for ${username}.` : `Signed in as ${username}.`
    });
    return body.access_token as string;
  }

  function startSession(accessToken: string, signedInUsername: string) {
    tokenRef.current = accessToken;
    allowReconnectRef.current = true;
    reconnectAttemptRef.current = 0;
    setToken(accessToken);
    setAuthenticatedUsername(signedInUsername);
    window.localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify({ token: accessToken, username: signedInUsername }));
    setPassword("");
    setError("");
  }

  function connect(accessToken = tokenRef.current) {
    if (!accessToken || !allowReconnectRef.current) {
      return;
    }
    if (socketRef.current?.readyState === WebSocket.OPEN || socketRef.current?.readyState === WebSocket.CONNECTING) {
      return;
    }
    const ws = new WebSocket(`${gatewayWs}/ws?token=${encodeURIComponent(accessToken)}`);
    socketRef.current = ws;

    ws.onopen = () => {
      reconnectAttemptRef.current = 0;
      setConnected(true);
      setChannelsLoaded(false);
      ws.send(JSON.stringify({ type: "list" }));
      pushLine({ kind: "status", text: "Connected to ChannelWire." });
    };
    ws.onmessage = (event) => handleGatewayEvent(JSON.parse(event.data), ws);
    ws.onclose = () => {
      if (socketRef.current === ws) {
        socketRef.current = null;
      }
      setConnected(false);
      setChannelsLoaded(false);
      setUsersLoaded(false);
      if (!allowReconnectRef.current || !tokenRef.current) {
        return;
      }
      pushLine({ kind: "status", text: "Connection lost. Reconnecting…" });
      const delay = Math.min(1000 * 2 ** reconnectAttemptRef.current, RECONNECT_MAX_DELAY_MS);
      reconnectAttemptRef.current += 1;
      reconnectTimerRef.current = window.setTimeout(() => connect(tokenRef.current), delay);
    };
    ws.onerror = () => ws.close();
  }

  function logout() {
    allowReconnectRef.current = false;
    tokenRef.current = "";
    activeChannelRef.current = "";
    clearStoredSession();
    if (reconnectTimerRef.current !== null) {
      window.clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
    if (socketRef.current?.readyState === WebSocket.OPEN) {
      socketRef.current.send(JSON.stringify({ type: "quit" }));
    }
    socketRef.current?.close();
    socketRef.current = null;
    setToken("");
    setAuthenticatedUsername("");
    setUsername("");
    setConnected(false);
    setPassword("");
    setActiveChannel("");
    setMessage("");
    setDmTo("");
    setDmText("");
    setMessages([]);
    setUsers([]);
    setUsersLoaded(false);
    setChannels([]);
    setChannelsLoaded(false);
    setPlatformStats(null);
    setCoreStats(null);
    setMonitorSamples([]);
    setPersistedChannels([]);
    setError("");
  }

  function send(command: object): boolean {
    if (socketRef.current?.readyState !== WebSocket.OPEN) {
      setError("Connection unavailable. Reconnecting…");
      return false;
    }
    socketRef.current.send(JSON.stringify(command));
    return true;
  }

  function requestChannels() {
    if (send({ type: "list" })) {
      setChannelsLoaded(false);
    }
  }

  function requestUsers() {
    if (send({ type: "who" })) {
      setUsersLoaded(false);
    }
  }

  function handleGatewayEvent(event: GatewayEvent, sourceSocket = socketRef.current) {
    if (event.type === "ready") {
      pushLine({ kind: "status", text: `Ready as ${event.username}.` });
      if (activeChannelRef.current && sourceSocket?.readyState === WebSocket.OPEN) {
        sourceSocket.send(JSON.stringify({ type: "join", channel: activeChannelRef.current }));
      }
    } else if (event.type === "chat") {
      pushLine({ kind: "chat", channel: event.channel, sender: event.sender, text: event.text });
    } else if (event.type === "dm") {
      pushLine({ kind: "dm", sender: event.sender, text: event.text });
    } else if (event.type === "system" || event.type === "ok") {
      pushLine({ kind: "system", text: friendlyGatewayMessage(event.message) });
      if (event.type === "ok" && /^(joined|switched) /.test(event.message)) {
        const nextActiveChannel = event.message.slice(event.message.indexOf(" ") + 1);
        activeChannelRef.current = nextActiveChannel;
        setActiveChannel(nextActiveChannel);
        setUsers([]);
        requestUsers();
      } else if (event.type === "ok" && event.message === "left channel") {
        activeChannelRef.current = "";
        setActiveChannel("");
        setUsers([]);
        setUsersLoaded(false);
      }
    } else if (event.type === "error") {
      const message = friendlyGatewayError(event.message);
      pushLine({ kind: "error", text: message });
      setError(message);
    } else if (event.type === "who") {
      setUsers(event.users);
      setUsersLoaded(true);
    } else if (event.type === "channels") {
      setChannels(event.channels);
      setChannelsLoaded(true);
    }
    refreshStats().catch(() => undefined);
  }

  function joinChannel(event: FormEvent) {
    event.preventDefault();
    send({ type: "join", channel });
    setTimeout(requestChannels, 100);
  }

  function sendChat(event: FormEvent) {
    event.preventDefault();
    const text = message.trim();
    if (!text) {
      setError("Enter a message or use /help.");
      return;
    }
    setMessage("");
    if (text.startsWith("/")) {
      void handleSlashCommand(text);
      return;
    }
    send({ type: "say", text });
  }

  async function handleSlashCommand(input: string) {
    const [command, ...parts] = input.slice(1).split(/\s+/);
    setError("");

    if (command === "help") {
      showHelp();
    } else if (command === "clear") {
      clearMessages();
    } else if (command === "join" || command === "switch" || command === "leave") {
      if (!parts[0]) {
        setError(`Enter a channel name after /${command}.`);
        return;
      }
      setChannel(parts[0]);
      send({ type: command, channel: parts[0] });
      if (command === "join") {
        setTimeout(requestChannels, 100);
      }
    } else if (command === "dm") {
      if (!parts[0] || !parts[1]) {
        setError("Enter a username and message to send a direct message.");
        return;
      }
      send({ type: "dm", to: parts[0], text: parts.slice(1).join(" ") });
    } else if (command === "who") {
      requestUsers();
    } else if (command === "list") {
      requestChannels();
    } else if (command === "quit") {
      logout();
    } else if (command === "stats") {
      await refreshStats();
      pushLine({ kind: "status", text: "Monitoring updated." });
    } else if (command === "history") {
      await loadHistory();
    } else {
      setError(`Command not recognized: /${command}. Use /help to view commands.`);
    }
  }

  function sendDirect(event: FormEvent) {
    event.preventDefault();
    const recipient = dmTo.trim();
    const text = dmText.trim();
    if (!recipient) {
      setError("Enter a username.");
      return;
    }
    if (!text) {
      setError("Enter a message.");
      return;
    }
    if (!/^[A-Za-z0-9_.-]{1,32}$/.test(recipient)) {
      setError("User not found. Check the username and try again.");
      return;
    }
    setError("");
    send({ type: "dm", to: recipient, text });
    setDmText("");
  }

  async function loadHistory() {
    if (!token) {
      setError("Sign in before loading channel history.");
      return;
    }
    const response = await fetch(`${gatewayHttp}/history/${encodeURIComponent(channel)}?token=${encodeURIComponent(token)}`);
    if (!response.ok) {
      setError(await responseError(response));
      return;
    }
    const body = await response.json();
    replaceMessages(
      body.messages.map((item: { id: number; sender: string; text: string }) => ({
        id: item.id,
        kind: "chat",
        channel,
        sender: item.sender,
        text: item.text
      }))
    );
  }

  async function loadDirectHistory() {
    if (!token || !dmTo) {
      setError("Enter a username to load direct message history.");
      return;
    }
    const response = await fetch(`${gatewayHttp}/history/dm/${encodeURIComponent(dmTo)}?token=${encodeURIComponent(token)}`);
    if (!response.ok) {
      setError(await responseError(response));
      return;
    }
    const body = await response.json();
    replaceMessages(
      body.messages.map((item: { id: number; sender: string; text: string }) => ({
        id: item.id,
        kind: "dm",
        sender: item.sender,
        text: item.text
      }))
    );
  }

  useEffect(() => {
    startReadinessCheck();
    return () => {
      cancelReadinessCheck();
      allowReconnectRef.current = false;
      if (reconnectTimerRef.current !== null) {
        window.clearTimeout(reconnectTimerRef.current);
      }
      socketRef.current?.close();
    };
  }, []);

  useEffect(() => {
    if (backendReadiness !== "ready" || !initialSession || restoredSessionStartedRef.current) {
      return;
    }
    restoredSessionStartedRef.current = true;
    void refreshStats(initialSession.token)
      .then((valid) => {
        if (valid && tokenRef.current === initialSession.token) connect(initialSession.token);
      })
      .catch(() => undefined);
  }, [backendReadiness]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ block: "end" });
  }, [messages]);

  return (
    <main className="appShell">
      <span className="srOnly" role="status" aria-live="polite">
        {backendReadiness === "checking"
          ? "Checking ChannelWire."
          : backendReadiness === "ready"
            ? "ChannelWire is ready."
            : ""}
      </span>
      <section className="topbar" aria-label="Account">
        <div className="brandLockup">
          <img className="brandLogo" src="/channelwire.png" alt="" />
          <div>
            <h1>ChannelWire</h1>
            <p>Real-time messaging and system monitoring</p>
          </div>
        </div>
        {backendReadiness === "ready" && (token ? (
          <div className="loggedInControls">
            <div className="signedInState">
              <span>Signed in as</span>
              <strong>{authenticatedUsername}</strong>
            </div>
            <button type="button" className="iconButton" onClick={logout}>
              <LogOut size={18} />
              Sign out
            </button>
          </div>
        ) : (
          <div className="connectionControls">
            <label>
              <span>Username</span>
              <input
                name="username"
                autoComplete="username"
                value={username}
                onChange={(event) => setUsername(event.target.value)}
              />
            </label>
            <label>
              <span>Password</span>
              <input
                type="password"
                name="password"
                autoComplete="current-password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                placeholder="At least 8 characters"
              />
            </label>
            <button type="button" className="iconButton" onClick={() => authenticate("register")}>
              <LogIn size={18} />
              Create account
            </button>
            <button type="button" className="iconButton" onClick={() => authenticate("login")}>
              <LogIn size={18} />
              Sign in
            </button>
            {devTokenEnabled && (
              <button type="button" className="iconButton" onClick={createToken}>
                <LogIn size={18} />
                Dev token
              </button>
            )}
          </div>
        ))}
      </section>

      {backendReadiness !== "ready" ? (
        <section className="readinessState" aria-labelledby="readiness-title">
          {backendReadiness === "checking" ? (
            <div className="panel readinessPanel" aria-busy="true">
              <div className="readinessIcon" aria-hidden="true">
                <RefreshCw className="readinessSpinner" size={24} />
              </div>
              <h2 id="readiness-title">Checking ChannelWire…</h2>
              <p>Waiting for the gateway to respond. This can take a moment after the service starts.</p>
              <div className="readinessProgress" role="progressbar" aria-label="Checking gateway readiness">
                <span />
              </div>
            </div>
          ) : (
            <div className="panel readinessPanel readinessFailure" role="alert">
              <div className="readinessIcon" aria-hidden="true">
                <AlertCircle size={24} />
              </div>
              <h2 id="readiness-title">ChannelWire isn’t ready</h2>
              <p>The gateway did not respond in time. Check that the service is running, then try again.</p>
              <button type="button" onClick={startReadinessCheck}>
                <RefreshCw size={17} aria-hidden="true" />
                Try again
              </button>
            </div>
          )}
        </section>
      ) : token ? (
        <section className="workspace">
        <aside className="sidebar" aria-label="Server status">
          <div className="panel">
            <div className="panelTitle">
              <Activity size={18} />
              Status
            </div>
            <div className="statusLine">
              <Circle className={connected ? "online" : "offline"} size={12} fill="currentColor" />
              {connected ? "Connected" : "Connecting…"}
            </div>
            <dl>
              <dt>Gateway</dt>
              <dd>{health?.status ?? "Unknown"}</dd>
              <dt>Core</dt>
              <dd>{health ? `${health.core_host}:${health.core_port}` : "Checking…"}</dd>
              <dt>Users</dt>
              <dd>{platformStats?.users ?? "—"}</dd>
              <dt>Channels</dt>
              <dd>{platformStats?.channels ?? "—"}</dd>
              <dt>Channel memberships</dt>
              <dd>{platformStats?.memberships ?? "—"}</dd>
              <dt>Stored messages</dt>
              <dd>{platformStats?.messages ?? "—"}</dd>
              <dt>Core clients</dt>
              <dd>{coreStats?.registered_clients ?? "—"}</dd>
              <dt>Queue disconnects</dt>
              <dd>{coreStats?.queue_disconnects ?? "—"}</dd>
              <dt>Session events</dt>
              <dd>{stats.events}</dd>
            </dl>
            <button
              className="iconButton"
              onClick={() => {
                void refreshHealth();
                refreshStats().catch((exc: Error) => setError(exc.message));
              }}
            >
              <RefreshCw size={16} />
              Refresh
            </button>
          </div>

          <div className="panel">
            <div className="panelTitle">
              <Hash size={18} />
              Channels
            </div>
            <button className="iconButton" disabled={!connected} onClick={requestChannels}>
              <RefreshCw size={16} />
              Refresh channels
            </button>
            <ul className="compactList">
              {!connected ? (
                <li className="emptyListItem">Connect to view channels</li>
              ) : !channelsLoaded ? (
                <li className="emptyListItem">Loading channels…</li>
              ) : channels.length > 0 ? (
                channels.map((item) => <li key={item}>{item}</li>)
              ) : (
                <li className="emptyListItem">No channels yet</li>
              )}
            </ul>
          </div>

          <div className="panel">
            <div className="panelTitle">
              <Users size={18} />
              Participants{activeChannel ? ` in #${activeChannel}` : ""}
            </div>
            <button
              className="iconButton"
              disabled={!connected || !activeChannel}
              onClick={requestUsers}
            >
              <RefreshCw size={16} />
              Refresh participants
            </button>
            <ul className="compactList">
              {!connected ? (
                <li className="emptyListItem">Connect to view participants</li>
              ) : !activeChannel ? (
                <li className="emptyListItem">Join a channel to view participants</li>
              ) : !usersLoaded ? (
                <li className="emptyListItem">Loading participants…</li>
              ) : users.length > 0 ? (
                users.map((item) => <li key={item}>{item}</li>)
              ) : (
                <li className="emptyListItem">No participants in this channel</li>
              )}
            </ul>
          </div>

          <div className="panel">
            <div className="panelTitle">
              <Hash size={18} />
              Stored channels
            </div>
            <ul className="compactList">
              {persistedChannels.length > 0 ? (
                persistedChannels.map((item) => <li key={item.name}>{item.name}</li>)
              ) : (
                <li className="emptyListItem">No stored channels yet</li>
              )}
            </ul>
          </div>

        </aside>

        <section className="chatSurface" aria-label="Messages">
          <div className="toolbar">
            <form onSubmit={joinChannel} className="channelForm">
              <Hash size={18} />
              <input
                aria-label="Channel name"
                name="channel"
                autoComplete="off"
                value={channel}
                onChange={(event) => setChannel(event.target.value)}
              />
              <button disabled={!connected}>Join</button>
            </form>
            <button className="iconButton" onClick={loadHistory}>
              <History size={16} />
              Load history
            </button>
            <button type="button" className="iconButton" onClick={showHelp}>
              <HelpCircle size={16} />
              View commands
            </button>
            <button type="button" className="iconButton" onClick={clearMessages}>
              <Trash2 size={16} />
              Clear view
            </button>
          </div>

          {(error || healthError) && (
            <div className="errorBanner" role="alert">
              <AlertCircle size={17} aria-hidden="true" />
              <span>{error || healthError}</span>
              <button
                type="button"
                className="dismissButton"
                aria-label="Dismiss error"
                onClick={() => (error ? setError("") : setHealthError(""))}
              >
                <X size={16} />
              </button>
            </div>
          )}

          <div className="messages">
            {messages.length > 0 ? (
              messages.map((item) => (
                <article key={item.id} className={`message ${item.kind}`}>
                  <header>
                    <span>{item.sender ?? item.kind}</span>
                    {item.channel && <small>#{item.channel}</small>}
                  </header>
                  <p>{item.text}</p>
                </article>
              ))
            ) : (
              <div className="emptyState">
                <div className="emptyStateIcon">
                  <MessagesSquare size={22} aria-hidden="true" />
                </div>
                <strong>
                  {connected
                    ? activeChannel
                      ? `You’re in #${activeChannel}`
                      : "Connected to ChannelWire"
                    : "Reconnecting to ChannelWire"}
                </strong>
                <p>
                  {connected
                    ? activeChannel
                      ? "Send a message or use /help to view commands."
                      : "Join a channel above to start messaging."
                    : "The real-time stream will resume automatically when the gateway is available."}
                </p>
              </div>
            )}
            <div ref={messagesEndRef} />
          </div>

          <form onSubmit={sendChat} className="composer">
            <MessagesSquare size={18} />
            <input
              aria-label="Message or command"
              name="message"
              autoComplete="off"
              value={message}
              onChange={(event) => setMessage(event.target.value)}
              placeholder={activeChannel ? `Message #${activeChannel}…` : "Type a command…"}
            />
            <button disabled={!connected}>
              <Send size={16} />
              Send
            </button>
          </form>
        </section>

        <aside className="sidebar" aria-label="Direct messages">
          <div className="panel">
            <div className="panelTitle">
              <Send size={18} />
              Direct message
            </div>
            <form onSubmit={sendDirect} className="stackForm">
              <label>
                <span>To</span>
                <input
                  name="recipient"
                  autoComplete="off"
                  value={dmTo}
                  onChange={(event) => setDmTo(event.target.value)}
                  placeholder="Username"
                />
              </label>
              <label>
                <span>Message</span>
                <textarea
                  name="direct-message"
                  value={dmText}
                  onChange={(event) => setDmText(event.target.value)}
                  placeholder="Write a direct message"
                />
              </label>
              <button disabled={!connected}>Send direct message</button>
              <button type="button" className="iconButton" onClick={loadDirectHistory}>
                <History size={16} />
                Load history
              </button>
            </form>
          </div>
          <div className="panel metricGrid">
            <div>
              <strong>{platformStats?.channel_messages ?? stats.messages}</strong>
              <span>Stored channel messages</span>
            </div>
            <div>
              <strong>{platformStats?.direct_messages ?? stats.direct}</strong>
              <span>Stored direct messages</span>
            </div>
          </div>
          <div className="panel">
            <div className="panelTitle">
              <Activity size={18} />
              Traffic monitor
            </div>
            <div className="meterGroup">
              <div className="meterLabel">
                <span>Channel message share</span>
                <strong>{monitoring.channelShare.toFixed(0)}%</strong>
              </div>
              <div className="meterTrack">
                <div className="meterFill channelMeter" style={{ width: `${monitoring.channelShare}%` }} />
              </div>
            </div>
            <div className="meterGroup">
              <div className="meterLabel">
                <span>Direct message share</span>
                <strong>{monitoring.directShare.toFixed(0)}%</strong>
              </div>
              <div className="meterTrack">
                <div className="meterFill directMeter" style={{ width: `${monitoring.directShare}%` }} />
              </div>
            </div>
            <div className="meterGroup">
              <div className="meterLabel">
                <span>Queue disconnect rate</span>
                <strong>{monitoring.queuePressure.toFixed(0)}%</strong>
              </div>
              <div className="meterTrack">
                <div className="meterFill pressureMeter" style={{ width: `${monitoring.queuePressure}%` }} />
              </div>
            </div>
            <dl className="compactStats">
              <dt>Malformed frames</dt>
              <dd>{monitoring.malformedFrames}</dd>
              <dt>Total connections</dt>
              <dd>{monitoring.totalConnections}</dd>
            </dl>
            <div className="trendGrid" aria-label="Monitoring trends">
              <div>
                <span>Stored messages</span>
                <Sparkline values={monitorSeries.messages} className="messageTrend" />
              </div>
              <div>
                <span>Queue disconnect rate</span>
                <Sparkline values={monitorSeries.queuePressure} className="queueTrend" />
              </div>
              <div>
                <span>Malformed frames</span>
                <Sparkline values={monitorSeries.malformedFrames} className="malformedTrend" />
              </div>
            </div>
          </div>
        </aside>
        </section>
      ) : (
        <section className="loggedOutState" aria-label="Signed out">
          <div className="panel">
            <h2>Sign in to ChannelWire</h2>
            <p>Sign in or create an account to use channels, direct messages, and monitoring.</p>
            {(error || healthError) && (
              <div className="errorBanner" role="alert">
                <AlertCircle size={17} aria-hidden="true" />
                <span>{error || healthError}</span>
                <button
                  type="button"
                  className="dismissButton"
                  aria-label="Dismiss error"
                  onClick={() => (error ? setError("") : setHealthError(""))}
                >
                  <X size={16} />
                </button>
              </div>
            )}
          </div>
        </section>
      )}
    </main>
  );
}

const rootElement = document.getElementById("root");
if (rootElement) {
  createRoot(rootElement).render(<App />);
}
