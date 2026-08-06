from __future__ import annotations

import pytest
from aiohttp import web

from chess_dossier.domain.enums import TimeControl
from chess_dossier.infrastructure.analysis.lichess import LichessGameSource


@pytest.mark.asyncio
async def test_lichess_source_uses_bounded_public_export(valid_pgn: bytes) -> None:
    observed: dict[str, str] = {}

    async def export(request: web.Request) -> web.Response:
        observed["username"] = request.match_info["username"]
        observed["perf_type"] = request.query["perfType"]
        observed["max"] = request.query["max"]
        observed["accept"] = request.headers["Accept"]
        return web.Response(body=valid_pgn, content_type="application/x-chess-pgn")

    app = web.Application()
    app.router.add_get("/api/games/user/{username}", export)
    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, "127.0.0.1", 0)
    await site.start()
    assert site._server is not None
    port = site._server.sockets[0].getsockname()[1]
    try:
        source = LichessGameSource(base_url=f"http://127.0.0.1:{port}")
        payload = await source.fetch(
            username="Example_User",
            time_control=TimeControl.BOTH,
            max_games=37,
            max_bytes=1024,
        )
    finally:
        await runner.cleanup()

    assert payload == valid_pgn
    assert observed == {
        "username": "Example_User",
        "perf_type": "blitz,rapid",
        "max": "37",
        "accept": "application/x-chess-pgn",
    }
