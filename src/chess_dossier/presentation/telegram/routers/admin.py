from __future__ import annotations

import io

from aiogram import Bot, F, Router
from aiogram.filters import Command
from aiogram.fsm.context import FSMContext
from aiogram.types import FSInputFile, Message

from chess_dossier.application.dto import DeliveryFile
from chess_dossier.application.ports import FileStorage
from chess_dossier.application.services import OrderService
from chess_dossier.config import Settings
from chess_dossier.domain.enums import ArtifactKind, OrderStatus
from chess_dossier.domain.errors import DomainError
from chess_dossier.presentation.telegram.artifacts import (
    ARTIFACT_DELIVERY_RANK,
    classify_artifact_filename,
)
from chess_dossier.presentation.telegram.states import AdminDelivery
from chess_dossier.presentation.telegram.texts import admin_card, source_prompt

router = Router(name="admin")


def _argument(message: Message) -> str:
    return (message.text or "").partition(" ")[2].strip().upper()


@router.message(Command("admin"))
async def admin_queue(message: Message, order_service: OrderService) -> None:
    orders = await order_service.list_active_orders()
    if not orders:
        await message.answer("Реестр пуст.")
        return
    await message.answer("\n\n".join(admin_card(order) for order in orders))


@router.message(Command("order"))
async def admin_order(message: Message, order_service: OrderService) -> None:
    public_id = _argument(message)
    if not public_id:
        await message.answer("Формат: /order CD-YYYYMMDD-XXXXXX")
        return
    try:
        order = await order_service.get_order(public_id)
    except DomainError as exc:
        await message.answer(str(exc))
        return
    await message.answer(admin_card(order))


@router.message(Command("paid"))
async def admin_paid(
    message: Message, order_service: OrderService, settings: Settings, bot: Bot
) -> None:
    public_id = _argument(message)
    if not public_id or message.from_user is None:
        await message.answer("Формат: /paid CD-YYYYMMDD-XXXXXX")
        return
    if settings.payment_mode != "manual":
        await message.answer("Ручное подтверждение отключено: production принимает Telegram Stars.")
        return
    try:
        order = await order_service.confirm_manual_payment(public_id, message.from_user.id)
    except DomainError as exc:
        await message.answer(f"Оплата не подтверждена: {exc}")
        return
    await bot.send_message(order.telegram_user_id, source_prompt(order))
    await message.answer(f"Оплата по делу {order.public_id} подтверждена.")


@router.message(Command("take"))
async def admin_take(message: Message, order_service: OrderService, bot: Bot) -> None:
    public_id = _argument(message)
    if not public_id or message.from_user is None:
        await message.answer("Формат: /take CD-YYYYMMDD-XXXXXX")
        return
    try:
        order = await order_service.take_order(public_id, message.from_user.id)
    except DomainError as exc:
        await message.answer(f"Дело не принято в работу: {exc}")
        return
    await bot.send_message(
        order.telegram_user_id,
        f"Дело <b>{order.public_id}</b> принято экспертом в работу.",
    )
    await message.answer(f"Дело {order.public_id} закреплено за вами.")


@router.message(Command("preview"))
async def admin_preview(
    message: Message,
    order_service: OrderService,
    file_storage: FileStorage,
    bot: Bot,
) -> None:
    public_id = _argument(message)
    if not public_id or message.from_user is None:
        await message.answer("Формат: /preview CD-YYYYMMDD-XXXXXX")
        return
    try:
        order, artifacts = await order_service.prepare_review(public_id, message.from_user.id)
    except DomainError as exc:
        await message.answer(f"Предпросмотр недоступен: {exc}")
        return
    await message.answer(
        f"Проверочный комплект {order.public_id}: {len(artifacts)} файлов. "
        "Эта отправка клиенту не засчитывается."
    )
    for artifact in sorted(artifacts, key=lambda item: ARTIFACT_DELIVERY_RANK[item.kind]):
        path = file_storage.path_for(artifact.storage_key)
        await bot.send_document(
            chat_id=message.chat.id,
            document=FSInputFile(path, filename=artifact.original_name),
        )


@router.message(Command("retry"))
async def admin_retry(message: Message, order_service: OrderService, bot: Bot) -> None:
    public_id = _argument(message)
    if not public_id or message.from_user is None:
        await message.answer("Формат: /retry CD-YYYYMMDD-XXXXXX")
        return
    try:
        order = await order_service.requeue_automated_analysis(public_id, message.from_user.id)
    except DomainError as exc:
        await message.answer(f"Повторный запуск невозможен: {exc}")
        return
    await bot.send_message(
        order.telegram_user_id,
        f"Дело <b>{order.public_id}</b> возвращено в очередь технической экспертизы.",
    )
    await message.answer(f"Дело {order.public_id} возвращено в очередь.")


@router.message(Command("deliver"))
async def begin_delivery(message: Message, state: FSMContext, order_service: OrderService) -> None:
    public_id = _argument(message)
    if not public_id or message.from_user is None:
        await message.answer("Формат: /deliver CD-YYYYMMDD-XXXXXX")
        return
    try:
        order = await order_service.take_order(public_id, message.from_user.id)
        if order.status not in {
            OrderStatus.IN_PROGRESS,
            OrderStatus.REVIEW_PENDING,
            OrderStatus.READY,
        }:
            raise ValueError(f"недопустимый статус: {order.status.value}")
    except (DomainError, ValueError) as exc:
        await message.answer(f"Выдача не начата: {exc}")
        return
    await state.set_state(AdminDelivery.collecting_files)
    await state.update_data(delivery_order_id=order.public_id)
    await message.answer(
        "Проверьте уже созданный комплект или загрузите/замените пять обязательных файлов:\n"
        "• report.pdf\n"
        "• errors_WHITE.pgn\n"
        "• errors_BLACK.pgn\n"
        "• conversion_WHITE.pgn\n"
        "• conversion_BLACK.pgn\n\n"
        "Автоматический комплект также содержит analysis.json. Если все уже на месте, сразу /done. "
        "Дополнительно можно загрузить plan_14d.pdf. Для отмены — /abort_delivery."
    )


@router.message(Command("abort_delivery"))
async def abort_delivery(message: Message, state: FSMContext) -> None:
    await state.clear()
    await message.answer("Режим загрузки закрыт. Уже сохраненные файлы остаются в карточке дела.")


@router.message(Command("done"), AdminDelivery.collecting_files)
async def finish_delivery(
    message: Message,
    state: FSMContext,
    order_service: OrderService,
    file_storage: FileStorage,
    bot: Bot,
) -> None:
    if message.from_user is None:
        return
    data = await state.get_data()
    public_id = str(data.get("delivery_order_id", ""))
    try:
        order, artifacts = await order_service.prepare_delivery(public_id, message.from_user.id)
    except DomainError as exc:
        await message.answer(f"Комплект неполон: {exc}")
        return

    for artifact in sorted(artifacts, key=lambda item: ARTIFACT_DELIVERY_RANK[item.kind]):
        if artifact.delivered_at is not None:
            continue
        path = file_storage.path_for(artifact.storage_key)
        await bot.send_document(
            chat_id=order.telegram_user_id,
            document=FSInputFile(path, filename=artifact.original_name),
        )
        await order_service.mark_artifact_delivered(
            public_id=public_id,
            artifact_id=artifact.id,
            admin_id=message.from_user.id,
        )
    await bot.send_message(
        order.telegram_user_id,
        f"<b>ДЕЛО {order.public_id} ЗАВЕРШЕНО</b>\n"
        "Заключение и тренировочные материалы вручены. Вопросы и исправления: /support",
    )
    await order_service.mark_delivered(public_id, message.from_user.id)
    await state.clear()
    await message.answer(f"Комплект по делу {public_id} отправлен клиенту.")


@router.message(AdminDelivery.collecting_files, F.document)
async def collect_delivery_file(
    message: Message,
    state: FSMContext,
    order_service: OrderService,
    settings: Settings,
    bot: Bot,
) -> None:
    if message.document is None or message.from_user is None:
        return
    filename = message.document.file_name or "deliverable.bin"
    kind = classify_artifact_filename(filename)
    if kind == ArtifactKind.SUPPLEMENT:
        await message.answer(
            "Тип файла не распознан. Используйте analysis.json, report.pdf, "
            "errors_WHITE/BLACK.pgn или conversion_WHITE/BLACK.pgn."
        )
        return
    if message.document.file_size and message.document.file_size > settings.max_upload_bytes:
        await message.answer("Файл превышает установленный лимит.")
        return
    data = await state.get_data()
    public_id = str(data.get("delivery_order_id", ""))
    buffer = io.BytesIO()
    await bot.download(message.document.file_id, destination=buffer)
    try:
        await order_service.add_artifact(
            public_id=public_id,
            admin_id=message.from_user.id,
            delivery=DeliveryFile(
                kind=kind,
                original_name=filename,
                content=buffer.getvalue(),
                telegram_file_id=message.document.file_id,
            ),
        )
        artifacts = await order_service.list_artifacts(public_id)
    except DomainError as exc:
        await message.answer(f"Файл не принят: {exc}")
        return
    accepted = ", ".join(sorted(artifact.kind.value for artifact in artifacts))
    await message.answer(f"Принято: {kind.value}. Сейчас в комплекте: {accepted}")
