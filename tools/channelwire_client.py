import socket
import struct
from dataclasses import dataclass


HELLO = 1
JOIN = 2
SWITCH = 3
LEAVE = 4
SAY = 5
DM = 6
WHO = 7
LIST = 8
NICK = 9
QUIT = 10
STATS = 11

OK = 101
ERROR = 102
CHAT = 103
DM_RECV = 104
SYSTEM = 105
WHO_RESP = 106
LIST_RESP = 107
STATS_RESP = 108


TYPE_NAMES = {
    OK: "OK",
    ERROR: "ERROR",
    CHAT: "CHAT",
    DM_RECV: "DM_RECV",
    SYSTEM: "SYSTEM",
    WHO_RESP: "WHO_RESP",
    LIST_RESP: "LIST_RESP",
    STATS_RESP: "STATS_RESP",
}


@dataclass(frozen=True)
class Frame:
    msg_type: int
    payload: bytes = b""


def string_payload(*values: str) -> bytes:
    out = bytearray()
    for value in values:
        encoded = value.encode("utf-8")
        if len(encoded) > 65535:
            raise ValueError("string is too large for ChannelWire framing")
        out += struct.pack("!H", len(encoded))
        out += encoded
    return bytes(out)


def encode_frame(msg_type: int, payload: bytes = b"") -> bytes:
    if len(payload) > 0xFFFFFFFF:
        raise ValueError("payload is too large for ChannelWire framing")
    return struct.pack("!BI", msg_type, len(payload)) + payload


def recv_exact(sock: socket.socket, length: int) -> bytes:
    chunks = bytearray()
    while len(chunks) < length:
        chunk = sock.recv(length - len(chunks))
        if not chunk:
            raise ConnectionError("socket closed before complete frame")
        chunks += chunk
    return bytes(chunks)


def read_frame(sock: socket.socket) -> Frame:
    header = recv_exact(sock, 5)
    msg_type, length = struct.unpack("!BI", header)
    return Frame(msg_type, recv_exact(sock, length))


def send_frame(sock: socket.socket, msg_type: int, payload: bytes = b"") -> None:
    sock.sendall(encode_frame(msg_type, payload))


def decode_strings(payload: bytes) -> list[str]:
    values = []
    offset = 0
    while offset < len(payload):
        if offset + 2 > len(payload):
            raise ValueError("truncated string length")
        (length,) = struct.unpack("!H", payload[offset : offset + 2])
        offset += 2
        if offset + length > len(payload):
            raise ValueError("truncated string payload")
        values.append(payload[offset : offset + length].decode("utf-8"))
        offset += length
    return values


def connect_registered(host: str, port: int, username: str, timeout: float = 3.0) -> socket.socket:
    sock = socket.create_connection((host, port), timeout=timeout)
    sock.settimeout(timeout)
    send_frame(sock, HELLO, string_payload(username))
    response = read_frame(sock)
    if response.msg_type != OK:
        text = response.payload.decode("utf-8", errors="replace")
        sock.close()
        raise RuntimeError(f"registration failed: {text}")
    return sock


def format_frame(frame: Frame) -> str:
    name = TYPE_NAMES.get(frame.msg_type, f"TYPE_{frame.msg_type}")

    if frame.msg_type == CHAT:
        channel, sender, text = decode_strings(frame.payload)
        return f"[{channel}] {sender}: {text}"
    if frame.msg_type == DM_RECV:
        sender, text = decode_strings(frame.payload)
        return f"[dm] {sender}: {text}"
    if frame.msg_type in (OK, ERROR, SYSTEM, WHO_RESP, LIST_RESP, STATS_RESP):
        text = frame.payload.decode("utf-8", errors="replace")
        return f"{name}: {text}" if text else name

    return f"{name}: {frame.payload.hex()}"
