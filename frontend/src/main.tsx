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

const gatewayHttp = import.meta.env.VITE_GATEWAY_URL ?? "http://127.0.0.1:8000";
const gatewayWs = gatewayHttp.replace(/^http/, "ws");

function App() {
  const [username, setUsername] = useState("alice");
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

  function pushLine(line: Omit<ChatLine, "id">) {
    setMessages((current) => [...current.slice(-199), { ...line, id: Date.now() + Math.random() }]);
  }

  async function refreshHealth() {
    const response = await fetch(`${gatewayHttp}/health`);
    if (!response.ok) {
      throw new Error("gateway health check failed");
    }
    setHealth(await response.json());
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
              <dt>Events</dt>
              <dd>{stats.events}</dd>
            </dl>
            <button className="iconButton" onClick={() => refreshHealth().catch((exc: Error) => setError(exc.message))}>
              <RefreshCw size={16} />
              Refresh
            </button>
          </div>

          <div className="panel">
            <div className="panelTitle">
              <Hash size={18} />
              Channels
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
              Users
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
            </form>
          </div>
          <div className="panel metricGrid">
            <div>
              <strong>{stats.messages}</strong>
              <span>Channel</span>
            </div>
            <div>
              <strong>{stats.direct}</strong>
              <span>Direct</span>
            </div>
          </div>
        </aside>
      </section>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
