import asyncio
import base64
import hashlib
import hmac
import json
import os
import secrets
import sys
import time
from collections import deque
from pathlib import Path
from typing import Any

import jwt
from fastapi import FastAPI, Header, HTTPException, Query, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "tools"))

from channelwire_client import (  # noqa: E402
    CHAT,
    DM,
    DM_RECV,
    ERROR,
    HELLO,
    JOIN,
    LEAVE,
    LIST,
    LIST_RESP,
    NICK,
    OK,
    QUIT,
    SAY,
    STATS,
    STATS_RESP,
    SWITCH,
    SYSTEM,
    WHO,
    WHO_RESP,
    decode_strings,
    encode_frame,
    string_payload,
)
from gateway.app.db import (  # noqa: E402
    add_membership,
    channel_history,
    create_user,
    direct_history,
    get_user,
    init_db,
    list_channels,
    list_users,
    save_channel_message,
    save_dm,
    session_scope,
    stats_snapshot,
    upsert_user,
    channel_members,
)


CORE_HOST = os.getenv("CHANNELWIRE_CORE_HOST", "127.0.0.1")
CORE_PORT = int(os.getenv("CHANNELWIRE_CORE_PORT", "5555"))
JWT_SECRET = os.getenv("CHANNELWIRE_JWT_SECRET", "dev-secret-change-me")
JWT_ALGORITHM = "HS256"
active_gateway_users: dict[str, int] = {}

CLIENT_COMMANDS = {
    "join": JOIN,
    "switch": SWITCH,
    "leave": LEAVE,
    "say": SAY,
    "dm": DM,
    "who": WHO,
    "list": LIST,
    "nick": NICK,
    "quit": QUIT,
    "stats": STATS,
}


class TokenRequest(BaseModel):
    username: str = Field(min_length=1, max_length=32, pattern=r"^[A-Za-z0-9_.-]+$")


class AuthRequest(TokenRequest):
    password: str = Field(min_length=8, max_length=128)


class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"


app = FastAPI(title="ChannelWire Gateway")
app.add_middleware(
    CORSMiddleware,
    allow_origins=os.getenv("CHANNELWIRE_CORS_ORIGINS", "*").split(","),
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.on_event("startup")
def startup() -> None:
    init_db()


def create_token(username: str) -> str:
    now = int(time.time())
    return jwt.encode(
        {"sub": username, "iat": now, "exp": now + 24 * 60 * 60},
        JWT_SECRET,
        algorithm=JWT_ALGORITHM,
    )


def hash_password(password: str, salt: bytes | None = None) -> str:
    salt = salt or secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, 210_000)
    return "pbkdf2_sha256$210000${}${}".format(
        base64.b64encode(salt).decode("ascii"),
        base64.b64encode(digest).decode("ascii"),
    )


def verify_password(password: str, encoded: str | None) -> bool:
    if not encoded:
        return False
    try:
        algorithm, iterations, salt_b64, digest_b64 = encoded.split("$", 3)
        if algorithm != "pbkdf2_sha256":
            return False
        salt = base64.b64decode(salt_b64)
        expected = base64.b64decode(digest_b64)
        actual = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, int(iterations))
    except (ValueError, TypeError):
        return False
    return hmac.compare_digest(actual, expected)


def verify_token(token: str) -> str:
    try:
        payload = jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALGORITHM])
    except jwt.PyJWTError as exc:
        raise HTTPException(status_code=401, detail="invalid token") from exc

    username = payload.get("sub")
    if not isinstance(username, str) or not username:
        raise HTTPException(status_code=401, detail="invalid token subject")
    return username


def verify_request_token(token: str | None = None, authorization: str | None = None) -> str:
    if authorization is not None and authorization.lower().startswith("bearer "):
        token = authorization[7:].strip()
    if not token:
        raise HTTPException(status_code=401, detail="missing token")
    return verify_token(token)


async def core_send(writer: asyncio.StreamWriter, msg_type: int, payload: bytes = b"") -> None:
    writer.write(encode_frame(msg_type, payload))
    await writer.drain()


async def core_read(reader: asyncio.StreamReader) -> tuple[int, bytes]:
    header = await reader.readexactly(5)
    msg_type = header[0]
    payload_len = int.from_bytes(header[1:], "big")
    payload = await reader.readexactly(payload_len)
    return msg_type, payload


async def open_registered_core(username: str) -> tuple[asyncio.StreamReader, asyncio.StreamWriter]:
    reader, writer = await asyncio.open_connection(CORE_HOST, CORE_PORT)
    await core_send(writer, HELLO, string_payload(username))
    msg_type, payload = await core_read(reader)
    if msg_type != OK:
        writer.close()
        await writer.wait_closed()
        detail = payload.decode("utf-8", errors="replace")
        raise HTTPException(status_code=409, detail=detail)
    return reader, writer


def core_payload_for_command(message: dict[str, Any]) -> tuple[int, bytes]:
    command = str(message.get("type", "")).lower()
    if command not in CLIENT_COMMANDS:
        raise ValueError("unknown command")

    msg_type = CLIENT_COMMANDS[command]
    if msg_type in (WHO, LIST, QUIT, STATS):
        return msg_type, b""
    if msg_type in (JOIN, SWITCH, LEAVE):
        channel = message.get("channel")
        if not isinstance(channel, str) or not channel:
            raise ValueError("command requires channel")
        return msg_type, string_payload(channel)
    if msg_type == SAY:
        text = message.get("text")
        if not isinstance(text, str) or not text:
            raise ValueError("say requires text")
        return msg_type, string_payload(text)
    if msg_type == NICK:
        username = message.get("username")
        if not isinstance(username, str) or not username:
            raise ValueError("nick requires username")
        return msg_type, string_payload(username)
    if msg_type == DM:
        target = message.get("to")
        text = message.get("text")
        if not isinstance(target, str) or not target or not isinstance(text, str) or not text:
            raise ValueError("dm requires to and text")
        return msg_type, string_payload(target, text)

    raise ValueError("unsupported command")


def gateway_event(msg_type: int, payload: bytes) -> dict[str, Any]:
    if msg_type == CHAT:
        channel, sender, text = decode_strings(payload)
        return {"type": "chat", "channel": channel, "sender": sender, "text": text}
    if msg_type == DM_RECV:
        sender, text = decode_strings(payload)
        return {"type": "dm", "sender": sender, "text": text}
    if msg_type == WHO_RESP:
        users = payload.decode("utf-8", errors="replace").splitlines()
        return {"type": "who", "users": users}
    if msg_type == LIST_RESP:
        channels = payload.decode("utf-8", errors="replace").splitlines()
        return {"type": "channels", "channels": channels}
    if msg_type == OK:
        return {"type": "ok", "message": payload.decode("utf-8", errors="replace")}
    if msg_type == ERROR:
        return {"type": "error", "message": payload.decode("utf-8", errors="replace")}
    if msg_type == SYSTEM:
        return {"type": "system", "message": payload.decode("utf-8", errors="replace")}
    if msg_type == STATS_RESP:
        try:
            return {"type": "core_stats", **json.loads(payload)}
        except json.JSONDecodeError:
            return {"type": "core_stats", "raw": payload.decode("utf-8", errors="replace")}
    return {"type": "raw", "message_type": msg_type, "payload": payload.hex()}


@app.get("/health")
async def health() -> dict[str, Any]:
    return {"status": "ok", "core_host": CORE_HOST, "core_port": CORE_PORT}


@app.post("/auth/dev-token", response_model=TokenResponse)
async def dev_token(request: TokenRequest) -> TokenResponse:
    with session_scope() as db:
        upsert_user(db, request.username)
        db.commit()
    return TokenResponse(access_token=create_token(request.username))


@app.post("/auth/register", response_model=TokenResponse)
async def register(request: AuthRequest) -> TokenResponse:
    with session_scope() as db:
        try:
            create_user(db, request.username, hash_password(request.password))
        except ValueError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc
        db.commit()
    return TokenResponse(access_token=create_token(request.username))


@app.post("/auth/login", response_model=TokenResponse)
async def login(request: AuthRequest) -> TokenResponse:
    with session_scope() as db:
        user = get_user(db, request.username)
        if user is None or not verify_password(request.password, user.password_hash):
            raise HTTPException(status_code=401, detail="invalid username or password")
    return TokenResponse(access_token=create_token(request.username))


@app.get("/channels")
async def channels(token: str | None = None, authorization: str | None = Header(default=None)) -> dict[str, Any]:
    username = verify_request_token(token, authorization)
    reader, writer = await open_registered_core(username)
    try:
        await core_send(writer, LIST)
        msg_type, payload = await core_read(reader)
        event = gateway_event(msg_type, payload)
        if event["type"] != "channels":
            raise HTTPException(status_code=502, detail=event)
        return event
    finally:
        await core_send(writer, QUIT)
        writer.close()
        await writer.wait_closed()


@app.get("/db/users")
async def persisted_users(token: str | None = None, authorization: str | None = Header(default=None)) -> dict[str, Any]:
    verify_request_token(token, authorization)
    with session_scope() as db:
        users = list_users(db)
        return {
            "type": "users",
            "users": [
                {"username": user.username, "created_at": user.created_at.isoformat()}
                for user in users
            ],
        }


@app.get("/db/channels")
async def persisted_channels(token: str | None = None, authorization: str | None = Header(default=None)) -> dict[str, Any]:
    verify_request_token(token, authorization)
    with session_scope() as db:
        channels = list_channels(db)
        return {
            "type": "channels",
            "channels": [
                {"name": channel.name, "created_at": channel.created_at.isoformat()}
                for channel in channels
            ],
        }


@app.get("/db/channels/{channel_name}/members")
async def persisted_channel_members(
    channel_name: str,
    token: str | None = None,
    authorization: str | None = Header(default=None),
) -> dict[str, Any]:
    verify_request_token(token, authorization)
    with session_scope() as db:
        members = channel_members(db, channel_name)
        return {
            "type": "members",
            "channel": channel_name,
            "members": [
                {"username": member.username, "joined_at": member.created_at.isoformat()}
                for member in members
            ],
        }


@app.get("/history/{channel_name}")
async def history(
    channel_name: str,
    token: str | None = None,
    authorization: str | None = Header(default=None),
    limit: int = Query(default=50, ge=1, le=200),
) -> dict[str, Any]:
    verify_request_token(token, authorization)
    with session_scope() as db:
        messages = channel_history(db, channel_name, limit)
        return {
            "type": "history",
            "channel": channel_name,
            "messages": [
                {
                    "id": message.id,
                    "sender": message.sender,
                    "text": message.body,
                    "created_at": message.created_at.isoformat(),
                }
                for message in messages
            ],
        }


@app.get("/history/dm/{other_username}")
async def dm_history(
    other_username: str,
    token: str | None = None,
    authorization: str | None = Header(default=None),
    limit: int = Query(default=50, ge=1, le=200),
) -> dict[str, Any]:
    username = verify_request_token(token, authorization)
    with session_scope() as db:
        messages = direct_history(db, username, other_username, limit)
        return {
            "type": "dm_history",
            "with": other_username,
            "messages": [
                {
                    "id": message.id,
                    "sender": message.sender,
                    "recipient": message.recipient,
                    "text": message.body,
                    "created_at": message.created_at.isoformat(),
                }
                for message in messages
            ],
        }


@app.get("/stats")
async def stats(token: str | None = None, authorization: str | None = Header(default=None)) -> dict[str, Any]:
    verify_request_token(token, authorization)
    with session_scope() as db:
        return {"type": "stats", **stats_snapshot(db)}


@app.get("/core-stats")
async def core_stats(token: str | None = None, authorization: str | None = Header(default=None)) -> dict[str, Any]:
    username = verify_request_token(token, authorization)
    reader, writer = await open_registered_core(username)
    try:
        await core_send(writer, STATS)
        msg_type, payload = await core_read(reader)
        event = gateway_event(msg_type, payload)
        if event["type"] != "core_stats":
            raise HTTPException(status_code=502, detail=event)
        return event
    finally:
        await core_send(writer, QUIT)
        writer.close()
        await writer.wait_closed()


@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket) -> None:
    token = websocket.query_params.get("token")
    if token is None:
        await websocket.close(code=4401)
        return

    try:
        username = verify_token(token)
        reader, writer = await open_registered_core(username)
    except HTTPException:
        await websocket.close(code=4401)
        return

    await websocket.accept()
    active_gateway_users[username] = active_gateway_users.get(username, 0) + 1
    await websocket.send_json({"type": "ready", "username": username})
    pending_dms: deque[tuple[str, str]] = deque()

    async def pump_core_to_ws() -> None:
        while True:
            msg_type, payload = await core_read(reader)
            event = gateway_event(msg_type, payload)
            if event["type"] == "chat" and event["sender"] == username:
                with session_scope() as db:
                    save_channel_message(db, event["channel"], event["sender"], event["text"])
                    db.commit()
            elif event["type"] == "dm":
                if active_gateway_users.get(event["sender"], 0) == 0:
                    with session_scope() as db:
                        save_dm(db, event["sender"], username, event["text"])
                        db.commit()
            elif event["type"] == "ok" and event["message"] == "direct message sent" and pending_dms:
                target, text = pending_dms.popleft()
                with session_scope() as db:
                    save_dm(db, username, target, text)
                    db.commit()
            elif event["type"] == "error" and pending_dms:
                pending_dms.popleft()
            await websocket.send_json(event)

    async def pump_ws_to_core() -> None:
        while True:
            raw = await websocket.receive_text()
            try:
                message = json.loads(raw)
                msg_type, payload = core_payload_for_command(message)
            except (json.JSONDecodeError, ValueError) as exc:
                await websocket.send_json({"type": "error", "message": str(exc)})
                continue
            if msg_type in (JOIN, SWITCH):
                with session_scope() as db:
                    add_membership(db, username, message["channel"])
                    db.commit()
            elif msg_type == DM:
                pending_dms.append((message["to"], message["text"]))
            await core_send(writer, msg_type, payload)
            if msg_type == QUIT:
                return

    core_task = asyncio.create_task(pump_core_to_ws())
    ws_task = asyncio.create_task(pump_ws_to_core())
    try:
        done, pending = await asyncio.wait(
            {core_task, ws_task},
            return_when=asyncio.FIRST_COMPLETED,
        )
        for task in done:
            task.result()
        for task in pending:
            task.cancel()
    except (WebSocketDisconnect, asyncio.IncompleteReadError, ConnectionError):
        pass
    finally:
        active_gateway_users[username] = max(active_gateway_users.get(username, 1) - 1, 0)
        if active_gateway_users[username] == 0:
            del active_gateway_users[username]
        writer.close()
        await writer.wait_closed()
