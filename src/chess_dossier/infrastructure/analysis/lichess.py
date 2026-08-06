from __future__ import annotations

from urllib.parse import quote

import aiohttp

from chess_dossier.analysis.errors import SourceFetchError
from chess_dossier.domain.enums import TimeControl


class LichessGameSource:
    def __init__(
        self,
        *,
        base_url: str = "https://lichess.org",
        token: str | None = None,
        user_agent: str = "chess-dossier/0.2",
        timeout_seconds: float = 60.0,
    ) -> None:
        self._base_url = base_url.rstrip("/")
        self._token = token
        self._user_agent = user_agent
        self._timeout = aiohttp.ClientTimeout(total=timeout_seconds)

    async def fetch(
        self,
        *,
        username: str,
        time_control: TimeControl,
        max_games: int,
        max_bytes: int,
    ) -> bytes:
        headers = {
            "Accept": "application/x-chess-pgn",
            "User-Agent": self._user_agent,
        }
        if self._token:
            headers["Authorization"] = f"Bearer {self._token}"
        perf_types = {
            TimeControl.BLITZ: "blitz",
            TimeControl.RAPID: "rapid",
            TimeControl.BOTH: "blitz,rapid",
        }
        params = {
            "max": str(max_games),
            "perfType": perf_types[time_control],
            "moves": "true",
            "tags": "true",
            "clocks": "true",
            "evals": "false",
            "opening": "true",
            "literate": "false",
        }
        url = f"{self._base_url}/api/games/user/{quote(username, safe='')}"
        try:
            async with aiohttp.ClientSession(timeout=self._timeout) as session:
                async with session.get(url, headers=headers, params=params) as response:
                    if response.status == 404:
                        raise SourceFetchError(f"Lichess user {username!r} was not found")
                    if response.status == 429:
                        raise SourceFetchError("Lichess rate limit reached; retry the order later")
                    if response.status >= 400:
                        raise SourceFetchError(
                            f"Lichess returned HTTP {response.status} while exporting games"
                        )
                    chunks: list[bytes] = []
                    size = 0
                    async for chunk in response.content.iter_chunked(64 * 1024):
                        size += len(chunk)
                        if size > max_bytes:
                            raise SourceFetchError(
                                "Lichess export exceeds the configured size limit"
                            )
                        chunks.append(chunk)
        except TimeoutError as exc:
            raise SourceFetchError("Lichess export timed out") from exc
        except aiohttp.ClientError as exc:
            raise SourceFetchError("Lichess export failed at the network boundary") from exc
        payload = b"".join(chunks)
        if not payload.strip():
            raise SourceFetchError(f"Lichess returned no {time_control.value} games for {username}")
        return payload
