from __future__ import annotations

from pathlib import Path

import pytest

from chess_dossier.infrastructure.storage.local import LocalFileStorage


def test_storage_rejects_path_traversal(tmp_path: Path) -> None:
    storage = LocalFileStorage(tmp_path / "storage")
    with pytest.raises(ValueError):
        storage.path_for("../../outside")


@pytest.mark.asyncio
async def test_storage_sanitizes_names_and_writes_atomically(tmp_path: Path) -> None:
    storage = LocalFileStorage(tmp_path / "storage")
    stored = await storage.save(
        order_id="../order",
        category="../source",
        filename="../../weird name.pgn",
        content=b"payload",
    )
    path = storage.path_for(stored.key)
    assert path.read_bytes() == b"payload"
    assert path.is_relative_to((tmp_path / "storage").resolve())
    assert ".." not in stored.key
