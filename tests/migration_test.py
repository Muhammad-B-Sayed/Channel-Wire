#!/usr/bin/env python3
import os
import sqlite3
import subprocess
import sys
import tempfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
EXPECTED_TABLES = {"alembic_version", "channels", "memberships", "messages", "users"}
EXPECTED_VERSION = "0001_initial_schema"


def run_python(code: str, database_path: Path, disable_alembic: bool = False) -> None:
    env = os.environ.copy()
    env["CHANNELWIRE_DATABASE_URL"] = f"sqlite:///{database_path}"
    if disable_alembic:
        env["CHANNELWIRE_DISABLE_ALEMBIC"] = "1"
    else:
        env.pop("CHANNELWIRE_DISABLE_ALEMBIC", None)
    subprocess.run([sys.executable, "-c", code], cwd=ROOT, env=env, check=True)


def assert_schema(database_path: Path) -> None:
    with sqlite3.connect(database_path) as db:
        tables = {row[0] for row in db.execute("select name from sqlite_master where type='table'")}
        assert EXPECTED_TABLES.issubset(tables), tables
        version = db.execute("select version_num from alembic_version").fetchone()
        assert version == (EXPECTED_VERSION,), version


def verify_fresh_migration(tmpdir: Path) -> None:
    database_path = tmpdir / "fresh.db"
    run_python("from gateway.app.db import init_db; init_db()", database_path)
    assert_schema(database_path)


def verify_legacy_adoption(tmpdir: Path) -> None:
    database_path = tmpdir / "legacy.db"
    run_python("from gateway.app.db import init_db; init_db()", database_path, disable_alembic=True)
    with sqlite3.connect(database_path) as db:
        tables = {row[0] for row in db.execute("select name from sqlite_master where type='table'")}
        assert "alembic_version" not in tables, tables

    run_python("from gateway.app.db import init_db; init_db()", database_path)
    assert_schema(database_path)


def main() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        tmpdir = Path(tmp)
        verify_fresh_migration(tmpdir)
        verify_legacy_adoption(tmpdir)


if __name__ == "__main__":
    main()
