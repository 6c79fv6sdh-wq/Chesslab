from pathlib import Path

import pytest

from chess_dossier.infrastructure.db.database import build_engine


@pytest.mark.asyncio
async def test_sqlite_engine_creates_database_parent(tmp_path: Path) -> None:
    database = tmp_path / "nested" / "database.sqlite3"
    engine = build_engine(f"sqlite+aiosqlite:///{database}")
    try:
        async with engine.begin() as connection:
            await connection.exec_driver_sql("SELECT 1")
    finally:
        await engine.dispose()

    assert database.is_file()
