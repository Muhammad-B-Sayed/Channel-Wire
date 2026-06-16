import os
from datetime import datetime, timezone

from sqlalchemy import DateTime, ForeignKey, Integer, String, Text, UniqueConstraint, create_engine, func, select
from sqlalchemy.orm import DeclarativeBase, Mapped, Session, mapped_column, sessionmaker


DATABASE_URL = os.getenv("CHANNELWIRE_DATABASE_URL", "sqlite:///./channelwire.db")

connect_args = {"check_same_thread": False} if DATABASE_URL.startswith("sqlite") else {}
engine = create_engine(DATABASE_URL, future=True, connect_args=connect_args)
SessionLocal = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False, future=True)


class Base(DeclarativeBase):
    pass


class User(Base):
    __tablename__ = "users"

    username: Mapped[str] = mapped_column(String(32), primary_key=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))


class Channel(Base):
    __tablename__ = "channels"

    name: Mapped[str] = mapped_column(String(32), primary_key=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))


class Membership(Base):
    __tablename__ = "memberships"
    __table_args__ = (UniqueConstraint("username", "channel_name", name="uq_membership_user_channel"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    username: Mapped[str] = mapped_column(ForeignKey("users.username"), index=True)
    channel_name: Mapped[str] = mapped_column(ForeignKey("channels.name"), index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))


class Message(Base):
    __tablename__ = "messages"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    kind: Mapped[str] = mapped_column(String(16), index=True)
    sender: Mapped[str] = mapped_column(ForeignKey("users.username"), index=True)
    channel_name: Mapped[str | None] = mapped_column(ForeignKey("channels.name"), nullable=True, index=True)
    recipient: Mapped[str | None] = mapped_column(ForeignKey("users.username"), nullable=True, index=True)
    body: Mapped[str] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc), index=True)


def init_db() -> None:
    Base.metadata.create_all(bind=engine)


def session_scope() -> Session:
    return SessionLocal()


def upsert_user(db: Session, username: str) -> None:
    if db.get(User, username) is None:
        db.add(User(username=username))


def ensure_channel(db: Session, channel_name: str) -> None:
    if db.get(Channel, channel_name) is None:
        db.add(Channel(name=channel_name))


def add_membership(db: Session, username: str, channel_name: str) -> None:
    upsert_user(db, username)
    ensure_channel(db, channel_name)
    exists = db.execute(
        select(Membership).where(
            Membership.username == username,
            Membership.channel_name == channel_name,
        )
    ).scalar_one_or_none()
    if exists is None:
        db.add(Membership(username=username, channel_name=channel_name))


def save_channel_message(db: Session, channel_name: str, sender: str, body: str) -> None:
    add_membership(db, sender, channel_name)
    db.add(Message(kind="channel", sender=sender, channel_name=channel_name, body=body))


def save_dm(db: Session, sender: str, recipient: str, body: str) -> None:
    upsert_user(db, sender)
    upsert_user(db, recipient)
    db.add(Message(kind="dm", sender=sender, recipient=recipient, body=body))


def channel_history(db: Session, channel_name: str, limit: int) -> list[Message]:
    return list(
        db.execute(
            select(Message)
            .where(Message.kind == "channel", Message.channel_name == channel_name)
            .order_by(Message.id.desc())
            .limit(limit)
        )
        .scalars()
        .all()
    )[::-1]


def stats_snapshot(db: Session) -> dict[str, int]:
    return {
        "users": db.scalar(select(func.count()).select_from(User)) or 0,
        "channels": db.scalar(select(func.count()).select_from(Channel)) or 0,
        "memberships": db.scalar(select(func.count()).select_from(Membership)) or 0,
        "messages": db.scalar(select(func.count()).select_from(Message)) or 0,
        "channel_messages": db.scalar(select(func.count()).where(Message.kind == "channel")) or 0,
        "direct_messages": db.scalar(select(func.count()).where(Message.kind == "dm")) or 0,
    }
