from __future__ import annotations

import asyncio
from contextlib import suppress

from chess_dossier.application.analysis_worker import AnalysisWorker
from chess_dossier.bootstrap import build_application
from chess_dossier.config import Settings
from chess_dossier.logging_config import configure_logging
from chess_dossier.presentation.telegram.bot import build_bot, build_dispatcher, register_commands
from chess_dossier.presentation.telegram.notifications import TelegramAnalysisNotifier


async def main() -> None:
    settings = Settings()
    configure_logging(settings.log_level)
    application = await build_application(settings)
    bot = build_bot(application)
    dispatcher = build_dispatcher(application)
    worker_stop = asyncio.Event()
    worker_task: asyncio.Task[None] | None = None
    worker: AnalysisWorker | None = None
    if application.analysis_pipeline is not None:
        worker = AnalysisWorker(
            order_service=application.order_service,
            storage=application.file_storage,
            runner=application.analysis_pipeline,
            remote_source=application.lichess_source,
            max_games=settings.max_games_per_order,
            max_source_bytes=settings.max_upload_bytes,
            poll_seconds=settings.analysis_worker_poll_seconds,
            notifier=TelegramAnalysisNotifier(bot=bot, admin_ids=settings.admin_id_set),
        )
    try:
        await register_commands(bot, settings.admin_id_set)
        if worker is not None:
            worker_task = asyncio.create_task(
                worker.run_forever(worker_stop), name="analysis-worker"
            )
        await dispatcher.start_polling(
            bot,
            allowed_updates=dispatcher.resolve_used_update_types(),
            close_bot_session=False,
        )
    finally:
        worker_stop.set()
        if worker_task is not None:
            worker_task.cancel()
            with suppress(asyncio.CancelledError):
                await worker_task
        await dispatcher.storage.close()
        await bot.session.close()
        await application.close()


def run() -> None:
    asyncio.run(main())


if __name__ == "__main__":
    run()
