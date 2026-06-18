import os
import re
from datetime import datetime, timezone
from pathlib import Path

from sqlalchemy import DateTime, ForeignKey, Integer, MetaData, String, Text, UniqueConstraint, and_, create_engine, func, inspect, or_, select, text
from sqlalchemy.orm import DeclarativeBase, Mapped, Session, mapped_column, sessionmaker


def normalize_database_url(url: str) -> str:
    if url.startswith("postgresql://"):
        return "postgresql+psycopg://" + url.removeprefix("postgresql://")
    if url.startswith("postgres://"):
        return "postgresql+psycopg://" + url.removeprefix("postgres://")
    return url


def normalize_schema_name(schema: str | None) -> str | None:
    if not schema:
        return None
    if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", schema):
        raise ValueError("CHANNELWIRE_DB_SCHEMA must be a plain SQL identifier, like channelwire")
    return schema


def table_ref(table_name: str, column_name: str) -> str:
    if DB_SCHEMA:
        return f"{DB_SCHEMA}.{table_name}.{column_name}"
    return f"{table_name}.{column_name}"


DATABASE_URL = normalize_database_url(os.getenv("CHANNELWIRE_DATABASE_URL", "sqlite:///./channelwire.db"))
DB_SCHEMA = normalize_schema_name(os.getenv("CHANNELWIRE_DB_SCHEMA"))

connect_args = {"check_same_thread": False} if DATABASE_URL.startswith("sqlite") else {}
engine = create_engine(DATABASE_URL, future=True, connect_args=connect_args)
SessionLocal = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False, future=True)


class Base(DeclarativeBase):
    metadata = MetaData(schema=DB_SCHEMA)


class User(Base):
    __tablename__ = "users"

    username: Mapped[str] = mapped_column(String(32), primary_key=True)
    password_hash: Mapped[str | None] = mapped_column(String(256), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))


class Channel(Base):
    __tablename__ = "channels"

    name: Mapped[str] = mapped_column(String(32), primary_key=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))


class Membership(Base):
    __tablename__ = "memberships"
    __table_args__ = (UniqueConstraint("username", "channel_name", name="uq_membership_user_channel"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    username: Mapped[str] = mapped_column(ForeignKey(table_ref("users", "username")), index=True)
    channel_name: Mapped[str] = mapped_column(ForeignKey(table_ref("channels", "name")), index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))


class Message(Base):
    __tablename__ = "messages"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    kind: Mapped[str] = mapped_column(String(16), index=True)
    sender: Mapped[str] = mapped_column(ForeignKey(table_ref("users", "username")), index=True)
    channel_name: Mapped[str | None] = mapped_column(ForeignKey(table_ref("channels", "name")), nullable=True, index=True)
    recipient: Mapped[str | None] = mapped_column(ForeignKey(table_ref("users", "username")), nullable=True, index=True)
    body: Mapped[str] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc), index=True)


def has_unversioned_schema() -> bool:
    tables = set(inspect(engine).get_table_names(schema=DB_SCHEMA))
    model_tables = {table.name for table in Base.metadata.sorted_tables}
    return "alembic_version" not in tables and model_tables.issubset(tables)


def migrate_db() -> None:
    from alembic import command
    from alembic.config import Config

    config_path = Path(__file__).resolve().parents[1] / "alembic.ini"
    config = Config(str(config_path))
    config.set_main_option("script_location", str(Path(__file__).resolve().parents[1] / "alembic"))
    config.set_main_option("sqlalchemy.url", DATABASE_URL)
    if has_unversioned_schema():
        create_schema_direct()
        command.stamp(config, "head")
        return
    command.upgrade(config, "head")


def create_schema_direct() -> None:
    if DB_SCHEMA and engine.dialect.name != "postgresql":
        raise RuntimeError("CHANNELWIRE_DB_SCHEMA is only supported with PostgreSQL")
    if DB_SCHEMA:
        with engine.begin() as conn:
            conn.execute(text(f'CREATE SCHEMA IF NOT EXISTS "{DB_SCHEMA}"'))
    Base.metadata.create_all(bind=engine)
    inspector = inspect(engine)
    if "users" in inspector.get_table_names(schema=DB_SCHEMA):
        columns = {column["name"] for column in inspector.get_columns("users", schema=DB_SCHEMA)}
        if "password_hash" not in columns:
            users_table = f'"{DB_SCHEMA}".users' if DB_SCHEMA else "users"
            with engine.begin() as conn:
                conn.execute(text(f"ALTER TABLE {users_table} ADD COLUMN password_hash VARCHAR(256)"))


def init_db() -> None:
    if os.getenv("CHANNELWIRE_DISABLE_ALEMBIC") == "1":
        create_schema_direct()
        return
    try:
        migrate_db()
    except ModuleNotFoundError:
        create_schema_direct()


def session_scope() -> Session:
    return SessionLocal()


def upsert_user(db: Session, username: str) -> None:
    if db.get(User, username) is None:
        db.add(User(username=username))


def create_user(db: Session, username: str, password_hash: str) -> User:
    if db.get(User, username) is not None:
        raise ValueError("username already exists")
    user = User(username=username, password_hash=password_hash)
    db.add(user)
    return user


def set_user_password(db: Session, username: str, password_hash: str) -> User:
    user = db.get(User, username)
    if user is None:
        user = User(username=username, password_hash=password_hash)
        db.add(user)
    else:
        user.password_hash = password_hash
    return user


def get_user(db: Session, username: str) -> User | None:
    return db.get(User, username)


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


def direct_history(db: Session, username: str, other_username: str, limit: int) -> list[Message]:
    return list(
        db.execute(
            select(Message)
            .where(
                Message.kind == "dm",
                or_(
                    and_(Message.sender == username, Message.recipient == other_username),
                    and_(Message.sender == other_username, Message.recipient == username),
                ),
            )
            .order_by(Message.id.desc())
            .limit(limit)
        )
        .scalars()
        .all()
    )[::-1]


def list_users(db: Session) -> list[User]:
    return list(db.execute(select(User).order_by(User.username)).scalars().all())


def list_channels(db: Session) -> list[Channel]:
    return list(db.execute(select(Channel).order_by(Channel.name)).scalars().all())


def channel_members(db: Session, channel_name: str) -> list[Membership]:
    return list(
        db.execute(
            select(Membership)
            .where(Membership.channel_name == channel_name)
            .order_by(Membership.username)
        )
        .scalars()
        .all()
    )


def stats_snapshot(db: Session) -> dict[str, int]:
    return {
        "users": db.scalar(select(func.count()).select_from(User)) or 0,
        "channels": db.scalar(select(func.count()).select_from(Channel)) or 0,
        "memberships": db.scalar(select(func.count()).select_from(Membership)) or 0,
        "messages": db.scalar(select(func.count()).select_from(Message)) or 0,
        "channel_messages": db.scalar(select(func.count()).where(Message.kind == "channel")) or 0,
        "direct_messages": db.scalar(select(func.count()).where(Message.kind == "dm")) or 0,
    }
