import React, { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  Activity,
  Cable,
  Circle,
  Hash,
  History,
  LogIn,
  MessagesSquare,
  RefreshCw,
  Send,
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

type PersistedUser = {
  username: string;
  created_at: string;
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

function App() {
  const [username, setUsername] = useState("alice");
  const [password, setPassword] = useState("");
  const [token, setToken] = useState("");
  const [channel, setChannel] = useState("general");
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
  const [persistedUsers, setPersistedUsers] = useState<PersistedUser[]>([]);
  const [persistedChannels, setPersistedChannels] = useState<PersistedChannel[]>([]);
  const [error, setError] = useState("");
  const socketRef = useRef<WebSocket | null>(null);

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
    setMessages((current) => [...current.slice(-199), { ...line, id: Date.now() + Math.random() }]);
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

  async function refreshStats(accessToken = token) {
    if (!accessToken) {
      return;
    }
    let nextPlatformStats: PlatformStats | null = null;
    let nextCoreStats: CoreStats | null = null;

    const response = await fetch(`${gatewayHttp}/stats?token=${encodeURIComponent(accessToken)}`);
    if (response.ok) {
      nextPlatformStats = await response.json();
      setPlatformStats(nextPlatformStats);
    }

    const coreResponse = await fetch(`${gatewayHttp}/core-stats?token=${encodeURIComponent(accessToken)}`);
    if (coreResponse.ok) {
      nextCoreStats = await coreResponse.json();
      setCoreStats(nextCoreStats);
    }

    if (nextPlatformStats && nextCoreStats) {
      recordMonitorSample(nextPlatformStats, nextCoreStats);
    }

    const usersResponse = await fetch(`${gatewayHttp}/db/users?token=${encodeURIComponent(accessToken)}`);
    if (usersResponse.ok) {
      const body = await usersResponse.json();
      setPersistedUsers(body.users);
    }

    const channelsResponse = await fetch(`${gatewayHttp}/db/channels?token=${encodeURIComponent(accessToken)}`);
    if (channelsResponse.ok) {
      const body = await channelsResponse.json();
      setPersistedChannels(body.channels);
    }
  }

  async function createToken() {
    const response = await fetch(`${gatewayHttp}/auth/dev-token`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username })
    });
    if (!response.ok) {
      throw new Error(await response.text());
    }
    const body = await response.json();
    setToken(body.access_token);
    await refreshStats(body.access_token);
    return body.access_token as string;
  }

  async function authenticate(path: "register" | "login") {
    setError("");
    const response = await fetch(`${gatewayHttp}/auth/${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username, password })
    });
    if (!response.ok) {
      setError(await response.text());
      return "";
    }
    const body = await response.json();
    setToken(body.access_token);
    await refreshStats(body.access_token);
    pushLine({ kind: "status", text: `${path === "register" ? "Registered" : "Logged in"} as ${username}` });
    return body.access_token as string;
  }

  async function connect() {
    setError("");
    const accessToken = token || (await createToken());
    const ws = new WebSocket(`${gatewayWs}/ws?token=${encodeURIComponent(accessToken)}`);
    socketRef.current = ws;

    ws.onopen = () => {
      setConnected(true);
      pushLine({ kind: "status", text: "WebSocket connected" });
    };
    ws.onmessage = (event) => handleGatewayEvent(JSON.parse(event.data));
    ws.onclose = () => {
      setConnected(false);
      pushLine({ kind: "status", text: "WebSocket closed" });
    };
    ws.onerror = () => setError("WebSocket error");
  }

  function disconnect() {
    socketRef.current?.send(JSON.stringify({ type: "quit" }));
    socketRef.current?.close();
    socketRef.current = null;
  }

  function send(command: object) {
    if (socketRef.current?.readyState !== WebSocket.OPEN) {
      setError("Connect before sending commands");
      return;
    }
    socketRef.current.send(JSON.stringify(command));
  }

  function handleGatewayEvent(event: GatewayEvent) {
    if (event.type === "ready") {
      pushLine({ kind: "status", text: `Ready as ${event.username}` });
    } else if (event.type === "chat") {
      pushLine({ kind: "chat", channel: event.channel, sender: event.sender, text: event.text });
    } else if (event.type === "dm") {
      pushLine({ kind: "dm", sender: event.sender, text: event.text });
    } else if (event.type === "system" || event.type === "ok") {
      pushLine({ kind: "system", text: event.message });
    } else if (event.type === "error") {
      pushLine({ kind: "error", text: event.message });
      setError(event.message);
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
    send({ type: "say", text: message });
    setMessage("");
  }

  function sendDirect(event: FormEvent) {
    event.preventDefault();
    send({ type: "dm", to: dmTo, text: dmText });
    setDmText("");
  }

  async function loadHistory() {
    if (!token) {
      setError("Create a token before loading history");
      return;
    }
    const response = await fetch(`${gatewayHttp}/history/${encodeURIComponent(channel)}?token=${encodeURIComponent(token)}`);
    if (!response.ok) {
      setError(await response.text());
      return;
    }
    const body = await response.json();
    setMessages(
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
      setError(await response.text());
      return;
    }
    const body = await response.json();
    setMessages(
      body.messages.map((item: { id: number; sender: string; text: string }) => ({
        id: item.id,
        kind: "dm",
        sender: item.sender,
        text: item.text
      }))
    );
  }

  useEffect(() => {
    refreshHealth().catch((exc: Error) => setError(exc.message));
    return () => socketRef.current?.close();
  }, []);

  return (
    <main className="appShell">
      <section className="topbar" aria-label="Connection">
        <div>
          <h1>ChannelWire</h1>
          <p>Realtime TCP core through a WebSocket/REST gateway</p>
        </div>
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
          <button type="button" className="iconButton" onClick={createToken}>
            <LogIn size={18} />
            Dev Token
          </button>
          <button onClick={connected ? disconnect : connect}>
            {connected ? <Cable size={18} /> : <LogIn size={18} />}
            {connected ? "Disconnect" : "Connect"}
          </button>
        </div>
      </section>

      <section className="workspace">
        <aside className="sidebar" aria-label="Server status">
          <div className="panel">
            <div className="panelTitle">
              <Activity size={18} />
              Status
            </div>
            <div className="statusLine">
              <Circle className={connected ? "online" : "offline"} size={12} fill="currentColor" />
              {connected ? "Connected" : "Disconnected"}
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
              Live Users
            </div>
            <button className="iconButton" onClick={() => send({ type: "who" })}>
              <RefreshCw size={16} />
              Who
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

          <div className="panel">
            <div className="panelTitle">
              <Users size={18} />
              Persisted Users
            </div>
            <ul className="compactList">
              {persistedUsers.map((item) => (
                <li key={item.username}>{item.username}</li>
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
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
