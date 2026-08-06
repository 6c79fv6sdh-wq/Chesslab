from __future__ import annotations

from aiogram import Bot, F, Router
from aiogram.types import CallbackQuery, Message, PreCheckoutQuery

from chess_dossier.application.services import OrderService
from chess_dossier.config import Settings
from chess_dossier.domain.enums import OrderStatus
from chess_dossier.domain.errors import DomainError
from chess_dossier.presentation.telegram.callbacks import PaymentCallback
from chess_dossier.presentation.telegram.notifications import notify_admins
from chess_dossier.presentation.telegram.texts import admin_card, source_prompt

router = Router(name="payments")


@router.callback_query(PaymentCallback.filter())
async def payment_callback(
    callback: CallbackQuery,
    callback_data: PaymentCallback,
    order_service: OrderService,
    settings: Settings,
    bot: Bot,
) -> None:
    if callback.from_user is None:
        await callback.answer()
        return
    if settings.payment_mode != "manual":
        await callback.answer("Ручное подтверждение отключено", show_alert=True)
        return
    try:
        order = await order_service.report_manual_payment(
            callback_data.order_id, callback.from_user.id
        )
    except DomainError as exc:
        await callback.answer(str(exc), show_alert=True)
        return
    if callback.message:
        if order.status == OrderStatus.PAYMENT_REVIEW:
            text = f"Отметка принята. Дело <b>{order.public_id}</b> передано на проверку платежа."
        else:
            text = f"Отметка по делу <b>{order.public_id}</b> уже обработана."
        await callback.message.answer(text)
    await notify_admins(bot, settings.admin_id_set, admin_card(order))
    await callback.answer("Принято")


@router.pre_checkout_query()
async def pre_checkout(query: PreCheckoutQuery, order_service: OrderService) -> None:
    valid = await order_service.validate_stars_payment(
        payload=query.invoice_payload,
        amount=query.total_amount,
        currency=query.currency,
    )
    await query.answer(ok=valid, error_message=None if valid else "Счет устарел или поврежден")


@router.message(F.successful_payment)
async def successful_payment(
    message: Message,
    order_service: OrderService,
    settings: Settings,
    bot: Bot,
) -> None:
    payment = message.successful_payment
    if payment is None:
        return
    try:
        order = await order_service.confirm_stars_payment(
            payload=payment.invoice_payload,
            charge_id=payment.telegram_payment_charge_id,
            amount=payment.total_amount,
            currency=payment.currency,
        )
    except DomainError as exc:
        await message.answer(f"Платеж получен, но карточка требует ручной проверки: {exc}")
        await notify_admins(bot, settings.admin_id_set, f"ПЛАТЕЖНАЯ ОШИБКА\n{exc}")
        return
    await message.answer(source_prompt(order))
    await notify_admins(bot, settings.admin_id_set, admin_card(order))
