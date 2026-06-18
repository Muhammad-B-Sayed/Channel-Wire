import sys
from logging.config import fileConfig
from pathlib import Path

from alembic import context
from sqlalchemy import engine_from_config, pool, text


ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

from gateway.app.db import Base, DATABASE_URL, DB_SCHEMA  # noqa: E402


config = context.config
if config.config_file_name is not None:
    fileConfig(config.config_file_name)

config.set_main_option("sqlalchemy.url", DATABASE_URL)
target_metadata = Base.metadata


def migration_options() -> dict[str, object]:
    return {
        "target_metadata": target_metadata,
        "include_schemas": DB_SCHEMA is not None,
        "version_table_schema": DB_SCHEMA,
    }


def create_schema_sql() -> str | None:
    if DB_SCHEMA is None:
        return None
    return f'CREATE SCHEMA IF NOT EXISTS "{DB_SCHEMA}"'


def run_migrations_offline() -> None:
    context.configure(
        url=config.get_main_option("sqlalchemy.url"),
        **migration_options(),
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
    )

    if sql := create_schema_sql():
        context.execute(sql)

    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    connectable = engine_from_config(
        config.get_section(config.config_ini_section, {}),
        prefix="sqlalchemy.",
        poolclass=pool.NullPool,
    )

    with connectable.connect() as connection:
        if sql := create_schema_sql():
            connection.execute(text(sql))
            connection.commit()

        context.configure(connection=connection, **migration_options())

        with context.begin_transaction():
            context.run_migrations()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
