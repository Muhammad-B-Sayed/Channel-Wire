import React, { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  Activity,
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
  Users
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
export const SESSION_STORAGE_KEY = "channelwire-session";
const HELP_TEXT = `Commands:
/help - show this help
/clear - clear visible messages
/join CHANNEL - join a channel
/switch CHANNEL - switch active channel
/leave CHANNEL - leave a channel
/dm USER MESSAGE - send a direct message
/who - list participants in the active channel
/list - list live channels
/stats - refresh monitoring
/history - load channel history
/quit - log out`;

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
  if (message === "user not found" || message === "invalid direct message" || message === "dm requires to and text") {
    return "User not found. Check the username and try again.";
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
  const [channels, setChannels] = useState<string[]>([]);
  const [health, setHealth] = useState<Health | null>(null);
  const [platformStats, setPlatformStats] = useState<PlatformStats | null>(null);
  const [coreStats, setCoreStats] = useState<CoreStats | null>(null);
  const [monitorSamples, setMonitorSamples] = useState<MonitorSample[]>([]);
  const [persistedChannels, setPersistedChannels] = useState<PersistedChannel[]>([]);
  const [error, setError] = useState("");
  const socketRef = useRef<WebSocket | null>(null);
  const tokenRef = useRef(initialSession?.token ?? "");
  const activeChannelRef = useRef("");
  const reconnectTimerRef = useRef<number | null>(null);
  const reconnectAttemptRef = useRef(0);
  const allowReconnectRef = useRef(Boolean(initialSession));
  const messagesEndRef = useRef<HTMLDivElement | null>(null);

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

  async function refreshHealth() {
    const response = await fetch(`${gatewayHttp}/health`);
    if (!response.ok) {
      throw new Error("gateway health check failed");
    }
    setHealth(await response.json());
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
      setError("Unable to reach the server. Please try again.");
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
      setError("Unable to reach the server. Please try again.");
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
    pushLine({ kind: "status", text: `${path === "register" ? "Registered" : "Logged in"} as ${username}` });
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
      pushLine({ kind: "status", text: "WebSocket connected" });
    };
    ws.onmessage = (event) => handleGatewayEvent(JSON.parse(event.data), ws);
    ws.onclose = () => {
      if (socketRef.current === ws) {
        socketRef.current = null;
      }
      setConnected(false);
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
    setChannels([]);
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

  function handleGatewayEvent(event: GatewayEvent, sourceSocket = socketRef.current) {
    if (event.type === "ready") {
      pushLine({ kind: "status", text: `Ready as ${event.username}` });
      if (activeChannelRef.current && sourceSocket?.readyState === WebSocket.OPEN) {
        sourceSocket.send(JSON.stringify({ type: "join", channel: activeChannelRef.current }));
      }
    } else if (event.type === "chat") {
      pushLine({ kind: "chat", channel: event.channel, sender: event.sender, text: event.text });
    } else if (event.type === "dm") {
      pushLine({ kind: "dm", sender: event.sender, text: event.text });
    } else if (event.type === "system" || event.type === "ok") {
      pushLine({ kind: "system", text: event.message });
      if (event.type === "ok" && /^(joined|switched) /.test(event.message)) {
        const nextActiveChannel = event.message.slice(event.message.indexOf(" ") + 1);
        activeChannelRef.current = nextActiveChannel;
        setActiveChannel(nextActiveChannel);
        setUsers([]);
        send({ type: "who" });
      } else if (event.type === "ok" && event.message === "left channel") {
        activeChannelRef.current = "";
        setActiveChannel("");
        setUsers([]);
      }
    } else if (event.type === "error") {
      const message = friendlyGatewayError(event.message);
      pushLine({ kind: "error", text: message });
      setError(message);
    } else if (event.type === "who") {
      setUsers(event.users);
    } else if (event.type === "channels") {
      setChannels(event.channels);
    }
    refreshStats().catch(() => undefined);
  }

  function joinChannel(event: FormEvent) {
    event.preventDefault();
    send({ type: "join", channel });
    setTimeout(() => send({ type: "list" }), 100);
  }

  function sendChat(event: FormEvent) {
    event.preventDefault();
    const text = message.trim();
    if (!text) {
      setError("Type a message or use /help");
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
        setError(`/${command} requires a channel`);
        return;
      }
      setChannel(parts[0]);
      send({ type: command, channel: parts[0] });
      if (command === "join") {
        setTimeout(() => send({ type: "list" }), 100);
      }
    } else if (command === "dm") {
      if (!parts[0] || !parts[1]) {
        setError("Enter a username and message to send a direct message.");
        return;
      }
      send({ type: "dm", to: parts[0], text: parts.slice(1).join(" ") });
    } else if (command === "who" || command === "list") {
      send({ type: command });
    } else if (command === "quit") {
      logout();
    } else if (command === "stats") {
      await refreshStats();
      pushLine({ kind: "status", text: "Monitoring refreshed" });
    } else if (command === "history") {
      await loadHistory();
    } else {
      setError(`Unknown command: /${command}. Try /help`);
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
      setError("Create a token before loading history");
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
      setError("Choose a DM recipient after connecting");
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
    refreshHealth().catch(() => undefined);
    if (initialSession) {
      void refreshStats(initialSession.token)
        .then((valid) => {
          if (valid && tokenRef.current === initialSession.token) connect(initialSession.token);
        })
        .catch(() => undefined);
    }
    return () => {
      allowReconnectRef.current = false;
      if (reconnectTimerRef.current !== null) {
        window.clearTimeout(reconnectTimerRef.current);
      }
      socketRef.current?.close();
    };
  }, []);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ block: "end" });
  }, [messages]);

  return (
    <main className="appShell">
      <section className="topbar" aria-label="Connection">
        <div className="brandLockup">
          <img className="brandLogo" src="/channelwire.png" alt="ChannelWire messaging platform logo" />
          <div>
            <h1>ChannelWire</h1>
            <p>Realtime TCP core through a WebSocket/REST gateway</p>
          </div>
        </div>
        {token ? (
          <div className="loggedInControls">
            <div className="signedInState">
              <span>Signed in as</span>
              <strong>{authenticatedUsername}</strong>
            </div>
            <button type="button" className="iconButton" onClick={logout}>
              <LogOut size={18} />
              Logout
            </button>
          </div>
        ) : (
          <div className="connectionControls">
            <label>
              <span>Username</span>
              <input value={username} onChange={(event) => setUsername(event.target.value)} />
            </label>
            <label>
              <span>Password</span>
              <input
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                placeholder="8+ chars"
              />
            </label>
            <button type="button" className="iconButton" onClick={() => authenticate("register")}>
              <LogIn size={18} />
              Register
            </button>
            <button type="button" className="iconButton" onClick={() => authenticate("login")}>
              <LogIn size={18} />
              Login
            </button>
            {devTokenEnabled && (
              <button type="button" className="iconButton" onClick={createToken}>
                <LogIn size={18} />
                Dev Token
              </button>
            )}
          </div>
        )}
      </section>

      {token ? (
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
              <dd>{health?.status ?? "unknown"}</dd>
              <dt>Core</dt>
              <dd>{health ? `${health.core_host}:${health.core_port}` : "checking"}</dd>
              <dt>Users</dt>
              <dd>{platformStats?.users ?? "-"}</dd>
              <dt>Channels</dt>
              <dd>{platformStats?.channels ?? "-"}</dd>
              <dt>Members</dt>
              <dd>{platformStats?.memberships ?? "-"}</dd>
              <dt>Stored</dt>
              <dd>{platformStats?.messages ?? "-"}</dd>
              <dt>Core Clients</dt>
              <dd>{coreStats?.registered_clients ?? "-"}</dd>
              <dt>Queue Drops</dt>
              <dd>{coreStats?.queue_disconnects ?? "-"}</dd>
              <dt>Events</dt>
              <dd>{stats.events}</dd>
            </dl>
            <button
              className="iconButton"
              onClick={() => {
                refreshHealth().catch((exc: Error) => setError(exc.message));
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
              Live Channels
            </div>
            <button className="iconButton" onClick={() => send({ type: "list" })}>
              <RefreshCw size={16} />
              List
            </button>
            <ul className="compactList">
              {channels.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </div>

          <div className="panel">
            <div className="panelTitle">
              <Users size={18} />
              Participants{activeChannel ? ` in #${activeChannel}` : ""}
            </div>
            <button className="iconButton" onClick={() => send({ type: "who" })}>
              <RefreshCw size={16} />
              Refresh
            </button>
            <ul className="compactList">
              {users.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </div>

          <div className="panel">
            <div className="panelTitle">
              <Hash size={18} />
              Persisted Channels
            </div>
            <ul className="compactList">
              {persistedChannels.map((item) => (
                <li key={item.name}>{item.name}</li>
              ))}
            </ul>
          </div>

        </aside>

        <section className="chatSurface" aria-label="Messaging">
          <div className="toolbar">
            <form onSubmit={joinChannel} className="channelForm">
              <Hash size={18} />
              <input value={channel} onChange={(event) => setChannel(event.target.value)} />
              <button>Join</button>
            </form>
            <button className="iconButton" onClick={loadHistory}>
              <History size={16} />
              History
            </button>
            <button type="button" className="iconButton" onClick={showHelp}>
              <HelpCircle size={16} />
              Help
            </button>
            <button type="button" className="iconButton" onClick={clearMessages}>
              <Trash2 size={16} />
              Clear
            </button>
          </div>

          {error && <div className="errorBanner">{error}</div>}

          <div className="messages">
            {messages.map((item) => (
              <article key={item.id} className={`message ${item.kind}`}>
                <header>
                  <span>{item.sender ?? item.kind}</span>
                  {item.channel && <small>#{item.channel}</small>}
                </header>
                <p>{item.text}</p>
              </article>
            ))}
            <div ref={messagesEndRef} />
          </div>

          <form onSubmit={sendChat} className="composer">
            <MessagesSquare size={18} />
            <input value={message} onChange={(event) => setMessage(event.target.value)} placeholder={`Message #${channel}`} />
            <button>
              <Send size={16} />
              Send
            </button>
          </form>
        </section>

        <aside className="sidebar" aria-label="Direct messages">
          <div className="panel">
            <div className="panelTitle">
              <Send size={18} />
              Direct Message
            </div>
            <form onSubmit={sendDirect} className="stackForm">
              <label>
                <span>To</span>
                <input value={dmTo} onChange={(event) => setDmTo(event.target.value)} />
              </label>
              <label>
                <span>Message</span>
                <textarea value={dmText} onChange={(event) => setDmText(event.target.value)} />
              </label>
              <button>Send DM</button>
              <button type="button" className="iconButton" onClick={loadDirectHistory}>
                <History size={16} />
                History
              </button>
            </form>
          </div>
          <div className="panel metricGrid">
            <div>
              <strong>{platformStats?.channel_messages ?? stats.messages}</strong>
              <span>Stored Channel</span>
            </div>
            <div>
              <strong>{platformStats?.direct_messages ?? stats.direct}</strong>
              <span>Stored Direct</span>
            </div>
          </div>
          <div className="panel">
            <div className="panelTitle">
              <Activity size={18} />
              Traffic Monitor
            </div>
            <div className="meterGroup">
              <div className="meterLabel">
                <span>Channel share</span>
                <strong>{monitoring.channelShare.toFixed(0)}%</strong>
              </div>
              <div className="meterTrack">
                <div className="meterFill channelMeter" style={{ width: `${monitoring.channelShare}%` }} />
              </div>
            </div>
            <div className="meterGroup">
              <div className="meterLabel">
                <span>Direct share</span>
                <strong>{monitoring.directShare.toFixed(0)}%</strong>
              </div>
              <div className="meterTrack">
                <div className="meterFill directMeter" style={{ width: `${monitoring.directShare}%` }} />
              </div>
            </div>
            <div className="meterGroup">
              <div className="meterLabel">
                <span>Queue pressure</span>
                <strong>{monitoring.queuePressure.toFixed(0)}%</strong>
              </div>
              <div className="meterTrack">
                <div className="meterFill pressureMeter" style={{ width: `${monitoring.queuePressure}%` }} />
              </div>
            </div>
            <dl className="compactStats">
              <dt>Malformed</dt>
              <dd>{monitoring.malformedFrames}</dd>
              <dt>Connections</dt>
              <dd>{monitoring.totalConnections}</dd>
            </dl>
            <div className="trendGrid" aria-label="Monitoring trends">
              <div>
                <span>Messages</span>
                <Sparkline values={monitorSeries.messages} className="messageTrend" />
              </div>
              <div>
                <span>Queue</span>
                <Sparkline values={monitorSeries.queuePressure} className="queueTrend" />
              </div>
              <div>
                <span>Malformed</span>
                <Sparkline values={monitorSeries.malformedFrames} className="malformedTrend" />
              </div>
            </div>
          </div>
        </aside>
        </section>
      ) : (
        <section className="loggedOutState" aria-label="Logged out">
          <div className="panel">
            <h2>Sign in to ChannelWire</h2>
            <p>Log in or register to access channels, messages, and monitoring.</p>
            {error && <div className="errorBanner">{error}</div>}
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
