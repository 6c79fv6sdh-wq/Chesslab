from __future__ import annotations

from aiogram.filters import BaseFilter
from aiogram.types import TelegramObject


class IsAdmin(BaseFilter):
    def __init__(self, admin_ids: frozenset[int]) -> None:
        self._admin_ids = admin_ids

    async def __call__(self, event: TelegramObject) -> bool:
        from_user = getattr(event, "from_user", None)
        return bool(from_user and from_user.id in self._admin_ids)
