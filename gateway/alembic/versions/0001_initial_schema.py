"""Create ChannelWire gateway schema.

Revision ID: 0001_initial_schema
Revises:
Create Date: 2026-06-17
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op


revision: str = "0001_initial_schema"
down_revision: str | None = None
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "users",
        sa.Column("username", sa.String(length=32), nullable=False),
        sa.Column("password_hash", sa.String(length=256), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint("username"),
    )
    op.create_table(
        "channels",
        sa.Column("name", sa.String(length=32), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint("name"),
    )
    op.create_table(
        "memberships",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("username", sa.String(length=32), nullable=False),
        sa.Column("channel_name", sa.String(length=32), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["channel_name"], ["channels.name"]),
        sa.ForeignKeyConstraint(["username"], ["users.username"]),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("username", "channel_name", name="uq_membership_user_channel"),
    )
    op.create_index(op.f("ix_memberships_channel_name"), "memberships", ["channel_name"], unique=False)
    op.create_index(op.f("ix_memberships_username"), "memberships", ["username"], unique=False)
    op.create_table(
        "messages",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("kind", sa.String(length=16), nullable=False),
        sa.Column("sender", sa.String(length=32), nullable=False),
        sa.Column("channel_name", sa.String(length=32), nullable=True),
        sa.Column("recipient", sa.String(length=32), nullable=True),
        sa.Column("body", sa.Text(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["channel_name"], ["channels.name"]),
        sa.ForeignKeyConstraint(["recipient"], ["users.username"]),
        sa.ForeignKeyConstraint(["sender"], ["users.username"]),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(op.f("ix_messages_channel_name"), "messages", ["channel_name"], unique=False)
    op.create_index(op.f("ix_messages_created_at"), "messages", ["created_at"], unique=False)
    op.create_index(op.f("ix_messages_kind"), "messages", ["kind"], unique=False)
    op.create_index(op.f("ix_messages_recipient"), "messages", ["recipient"], unique=False)
    op.create_index(op.f("ix_messages_sender"), "messages", ["sender"], unique=False)


def downgrade() -> None:
    op.drop_index(op.f("ix_messages_sender"), table_name="messages")
    op.drop_index(op.f("ix_messages_recipient"), table_name="messages")
    op.drop_index(op.f("ix_messages_kind"), table_name="messages")
    op.drop_index(op.f("ix_messages_created_at"), table_name="messages")
    op.drop_index(op.f("ix_messages_channel_name"), table_name="messages")
    op.drop_table("messages")
    op.drop_index(op.f("ix_memberships_username"), table_name="memberships")
    op.drop_index(op.f("ix_memberships_channel_name"), table_name="memberships")
    op.drop_table("memberships")
    op.drop_table("channels")
    op.drop_table("users")
