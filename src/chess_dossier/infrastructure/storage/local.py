from __future__ import annotations

import asyncio
import hashlib
import os
import re
import tempfile
from pathlib import Path

from chess_dossier.application.dto import StoredFile

_SAFE_NAME = re.compile(r"[^A-Za-z0-9._-]+")


class LocalFileStorage:
    def __init__(self, root: Path) -> None:
        self._root = root.resolve()

    async def save(
        self, *, order_id: str, category: str, filename: str, content: bytes
    ) -> StoredFile:
        checksum = hashlib.sha256(content).hexdigest()
        safe_name = self._sanitize(filename)
        relative = (
            Path(self._sanitize(order_id))
            / self._sanitize(category)
            / f"{checksum[:12]}-{safe_name}"
        )
        destination = self.path_for(relative.as_posix())
        await asyncio.to_thread(self._atomic_write, destination, content)
        return StoredFile(
            key=relative.as_posix(), checksum_sha256=checksum, size_bytes=len(content)
        )

    def path_for(self, key: str) -> Path:
        candidate = (self._root / key).resolve()
        if candidate != self._root and self._root not in candidate.parents:
            raise ValueError("Storage key escapes configured root")
        return candidate

    async def read(self, key: str) -> bytes:
        path = self.path_for(key)
        return await asyncio.to_thread(path.read_bytes)

    @staticmethod
    def _sanitize(value: str) -> str:
        base = Path(value).name.strip()
        cleaned = _SAFE_NAME.sub("_", base).strip("._")
        return cleaned[:120] or "file"

    @staticmethod
    def _atomic_write(destination: Path, content: bytes) -> None:
        destination.parent.mkdir(parents=True, exist_ok=True)
        if destination.exists() and destination.read_bytes() == content:
            return
        fd, temp_name = tempfile.mkstemp(prefix=".upload-", dir=destination.parent)
        try:
            with os.fdopen(fd, "wb") as handle:
                handle.write(content)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temp_name, destination)
        finally:
            if os.path.exists(temp_name):
                os.unlink(temp_name)
