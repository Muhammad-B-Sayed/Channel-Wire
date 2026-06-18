"""Create ChannelWire gateway schema.

Revision ID: 0001_initial_schema
Revises:
Create Date: 2026-06-17
"""

from collections.abc import Sequence
import os
import re

import sqlalchemy as sa
from alembic import op


revision: str = "0001_initial_schema"
down_revision: str | None = None
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def schema_name() -> str | None:
    schema = os.getenv("CHANNELWIRE_DB_SCHEMA")
    if not schema:
        return None
    if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", schema):
        raise ValueError("CHANNELWIRE_DB_SCHEMA must be a plain SQL identifier, like channelwire")
    return schema


def table_ref(schema: str | None, table_name: str, column_name: str) -> str:
    if schema:
        return f"{schema}.{table_name}.{column_name}"
    return f"{table_name}.{column_name}"


def upgrade() -> None:
    schema = schema_name()
    if schema and op.get_context().dialect.name != "postgresql":
        raise RuntimeError("CHANNELWIRE_DB_SCHEMA is only supported with PostgreSQL")
    if schema:
        op.execute(sa.text(f'CREATE SCHEMA IF NOT EXISTS "{schema}"'))

    op.create_table(
        "users",
        sa.Column("username", sa.String(length=32), nullable=False),
        sa.Column("password_hash", sa.String(length=256), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint("username"),
        schema=schema,
    )
    op.create_table(
        "channels",
        sa.Column("name", sa.String(length=32), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint("name"),
        schema=schema,
    )
    op.create_table(
        "memberships",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("username", sa.String(length=32), nullable=False),
        sa.Column("channel_name", sa.String(length=32), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["channel_name"], [table_ref(schema, "channels", "name")]),
        sa.ForeignKeyConstraint(["username"], [table_ref(schema, "users", "username")]),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("username", "channel_name", name="uq_membership_user_channel"),
        schema=schema,
    )
    op.create_index(op.f("ix_memberships_channel_name"), "memberships", ["channel_name"], unique=False, schema=schema)
    op.create_index(op.f("ix_memberships_username"), "memberships", ["username"], unique=False, schema=schema)
    op.create_table(
        "messages",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("kind", sa.String(length=16), nullable=False),
        sa.Column("sender", sa.String(length=32), nullable=False),
        sa.Column("channel_name", sa.String(length=32), nullable=True),
        sa.Column("recipient", sa.String(length=32), nullable=True),
        sa.Column("body", sa.Text(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["channel_name"], [table_ref(schema, "channels", "name")]),
        sa.ForeignKeyConstraint(["recipient"], [table_ref(schema, "users", "username")]),
        sa.ForeignKeyConstraint(["sender"], [table_ref(schema, "users", "username")]),
        sa.PrimaryKeyConstraint("id"),
        schema=schema,
    )
    op.create_index(op.f("ix_messages_channel_name"), "messages", ["channel_name"], unique=False, schema=schema)
    op.create_index(op.f("ix_messages_created_at"), "messages", ["created_at"], unique=False, schema=schema)
    op.create_index(op.f("ix_messages_kind"), "messages", ["kind"], unique=False, schema=schema)
    op.create_index(op.f("ix_messages_recipient"), "messages", ["recipient"], unique=False, schema=schema)
    op.create_index(op.f("ix_messages_sender"), "messages", ["sender"], unique=False, schema=schema)


def downgrade() -> None:
    schema = schema_name()
    op.drop_index(op.f("ix_messages_sender"), table_name="messages", schema=schema)
    op.drop_index(op.f("ix_messages_recipient"), table_name="messages", schema=schema)
    op.drop_index(op.f("ix_messages_kind"), table_name="messages", schema=schema)
    op.drop_index(op.f("ix_messages_created_at"), table_name="messages", schema=schema)
    op.drop_index(op.f("ix_messages_channel_name"), table_name="messages", schema=schema)
    op.drop_table("messages", schema=schema)
    op.drop_index(op.f("ix_memberships_username"), table_name="memberships", schema=schema)
    op.drop_index(op.f("ix_memberships_channel_name"), table_name="memberships", schema=schema)
    op.drop_table("memberships", schema=schema)
    op.drop_table("channels", schema=schema)
    op.drop_table("users", schema=schema)
