import asyncio
import json
import os
import sys
import time
from pathlib import Path
from typing import Any

import jwt
from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
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
    SWITCH,
    SYSTEM,
    WHO,
    WHO_RESP,
    decode_strings,
    encode_frame,
    string_payload,
)


CORE_HOST = os.getenv("CHANNELWIRE_CORE_HOST", "127.0.0.1")
CORE_PORT = int(os.getenv("CHANNELWIRE_CORE_PORT", "5555"))
JWT_SECRET = os.getenv("CHANNELWIRE_JWT_SECRET", "dev-secret-change-me")
JWT_ALGORITHM = "HS256"

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
}


class TokenRequest(BaseModel):
    username: str = Field(min_length=1, max_length=32, pattern=r"^[A-Za-z0-9_.-]+$")


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


def create_token(username: str) -> str:
    now = int(time.time())
    return jwt.encode(
        {"sub": username, "iat": now, "exp": now + 24 * 60 * 60},
        JWT_SECRET,
        algorithm=JWT_ALGORITHM,
    )


def verify_token(token: str) -> str:
    try:
        payload = jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALGORITHM])
    except jwt.PyJWTError as exc:
        raise HTTPException(status_code=401, detail="invalid token") from exc

    username = payload.get("sub")
    if not isinstance(username, str) or not username:
        raise HTTPException(status_code=401, detail="invalid token subject")
    return username


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
    if msg_type in (WHO, LIST, QUIT):
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
    return {"type": "raw", "message_type": msg_type, "payload": payload.hex()}


@app.get("/health")
async def health() -> dict[str, Any]:
    return {"status": "ok", "core_host": CORE_HOST, "core_port": CORE_PORT}


@app.post("/auth/dev-token", response_model=TokenResponse)
async def dev_token(request: TokenRequest) -> TokenResponse:
    return TokenResponse(access_token=create_token(request.username))


@app.get("/channels")
async def channels(token: str) -> dict[str, Any]:
    username = verify_token(token)
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
    await websocket.send_json({"type": "ready", "username": username})

    async def pump_core_to_ws() -> None:
        while True:
            msg_type, payload = await core_read(reader)
            await websocket.send_json(gateway_event(msg_type, payload))

    async def pump_ws_to_core() -> None:
        while True:
            raw = await websocket.receive_text()
            try:
                msg_type, payload = core_payload_for_command(json.loads(raw))
            except (json.JSONDecodeError, ValueError) as exc:
                await websocket.send_json({"type": "error", "message": str(exc)})
                continue
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
        writer.close()
        await writer.wait_closed()
