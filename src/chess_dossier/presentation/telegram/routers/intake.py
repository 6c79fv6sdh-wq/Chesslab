from __future__ import annotations

from aiogram import Bot, F, Router
from aiogram.fsm.context import FSMContext
from aiogram.types import CallbackQuery, LabeledPrice, Message, ReplyKeyboardRemove

from chess_dossier.application.dto import CreateOrderCommand
from chess_dossier.application.services import OrderService
from chess_dossier.config import Settings
from chess_dossier.domain.enums import ReportLanguage, SourceType, TimeControl
from chess_dossier.domain.errors import ActiveOrderExists, CapacityExceeded, DomainError
from chess_dossier.presentation.telegram.callbacks import IntakeCallback
from chess_dossier.presentation.telegram.keyboards import (
    contact_menu,
    language_menu,
    manual_payment_menu,
    rating_skip,
    review_menu,
    time_control_menu,
)
from chess_dossier.presentation.telegram.notifications import notify_admins
from chess_dossier.presentation.telegram.states import OrderIntake
from chess_dossier.presentation.telegram.texts import admin_card, intake_review

router = Router(name="intake")


@router.callback_query(OrderIntake.choosing_source, IntakeCallback.filter(F.field == "source"))
async def choose_source(
    callback: CallbackQuery, callback_data: IntakeCallback, state: FSMContext
) -> None:
    SourceType(callback_data.value)
    await state.update_data(source_type=callback_data.value)
    if SourceType(callback_data.value) == SourceType.LICHESS:
        if isinstance(callback.message, Message):
            await _ask_rating(callback.message, state)
    else:
        await state.set_state(OrderIntake.entering_player_name)
        if callback.message:
            await callback.message.answer(
                "Как именно записан исследуемый игрок в тегах White/Black вашего PGN? "
                "Нужное имя должно совпадать полностью."
            )
    await callback.answer()


@router.message(OrderIntake.entering_player_name, F.text)
async def enter_player_name(message: Message, state: FSMContext) -> None:
    player_name = (message.text or "").strip()
    if not 1 <= len(player_name) <= 100 or "\n" in player_name:
        await message.answer("Имя игрока должно содержать от 1 до 100 символов одной строкой.")
        return
    await state.update_data(player_name=player_name)
    await _ask_rating(message, state)


async def _ask_rating(message: Message, state: FSMContext) -> None:
    await state.set_state(OrderIntake.entering_rating)
    await message.answer(
        "Укажите ориентировочный рейтинг числом от 100 до 3500.",
        reply_markup=rating_skip(),
    )


@router.message(OrderIntake.entering_rating, F.text)
async def enter_rating(message: Message, state: FSMContext) -> None:
    value = (message.text or "").strip()
    if not value.isdigit() or not 100 <= int(value) <= 3500:
        await message.answer("Нужна целая цифра от 100 до 3500 либо кнопка «Не указывать».")
        return
    await state.update_data(rating=int(value))
    await _ask_time_control(message, state)


@router.callback_query(
    OrderIntake.entering_rating, IntakeCallback.filter((F.field == "rating") & (F.value == "skip"))
)
async def skip_rating(callback: CallbackQuery, state: FSMContext) -> None:
    await state.update_data(rating=None)
    if isinstance(callback.message, Message):
        await _ask_time_control(callback.message, state)
    await callback.answer()


async def _ask_time_control(message: Message, state: FSMContext) -> None:
    await state.set_state(OrderIntake.choosing_time_control)
    await message.answer("Какие партии исследовать?", reply_markup=time_control_menu())


@router.callback_query(OrderIntake.choosing_time_control, IntakeCallback.filter(F.field == "time"))
async def choose_time(
    callback: CallbackQuery, callback_data: IntakeCallback, state: FSMContext
) -> None:
    TimeControl(callback_data.value)
    await state.update_data(time_control=callback_data.value)
    await state.set_state(OrderIntake.choosing_language)
    if callback.message:
        await callback.message.answer("Язык заключения:", reply_markup=language_menu())
    await callback.answer()


@router.callback_query(OrderIntake.choosing_language, IntakeCallback.filter(F.field == "language"))
async def choose_language(
    callback: CallbackQuery, callback_data: IntakeCallback, state: FSMContext
) -> None:
    ReportLanguage(callback_data.value)
    await state.update_data(report_language=callback_data.value)
    await state.set_state(OrderIntake.entering_contact)
    if callback.message:
        await callback.message.answer(
            "Передайте контакт для связи. Можно использовать кнопку или написать @username/телефон.",
            reply_markup=contact_menu(),
        )
    await callback.answer()


@router.message(OrderIntake.entering_contact, F.contact)
async def enter_contact_button(message: Message, state: FSMContext, settings: Settings) -> None:
    if message.contact is None or message.from_user is None:
        return
    if message.contact.user_id and message.contact.user_id != message.from_user.id:
        await message.answer("Нужен ваш собственный контакт, а не телефон случайного участкового.")
        return
    await state.update_data(contact=message.contact.phone_number)
    await _show_review(message, state, settings)


@router.message(OrderIntake.entering_contact, F.text)
async def enter_contact_text(message: Message, state: FSMContext, settings: Settings) -> None:
    contact = (message.text or "").strip()
    if not 3 <= len(contact) <= 100:
        await message.answer("Контакт должен содержать от 3 до 100 символов.")
        return
    await state.update_data(contact=contact)
    await _show_review(message, state, settings)


async def _show_review(message: Message, state: FSMContext, settings: Settings) -> None:
    await state.set_state(OrderIntake.reviewing)
    data = await state.get_data()
    await message.answer(
        intake_review(
            data,
            price_rub=settings.display_price_rub,
            stars_amount=(
                settings.star_price if settings.payment_mode == "telegram_stars" else None
            ),
        ),
        reply_markup=review_menu(),
    )
    await message.answer("Карточка заполнена.", reply_markup=ReplyKeyboardRemove())


@router.callback_query(OrderIntake.reviewing, IntakeCallback.filter(F.field == "review"))
async def finish_intake(
    callback: CallbackQuery,
    callback_data: IntakeCallback,
    state: FSMContext,
    order_service: OrderService,
    settings: Settings,
    bot: Bot,
) -> None:
    if callback_data.value == "cancel":
        await state.clear()
        if callback.message:
            await callback.message.answer("Черновик уничтожен.")
        await callback.answer()
        return
    if callback.from_user is None or callback.message is None:
        await callback.answer()
        return
    data = await state.get_data()
    try:
        order = await order_service.create_order(
            CreateOrderCommand(
                telegram_user_id=callback.from_user.id,
                source_type=SourceType(str(data["source_type"])),
                time_control=TimeControl(str(data["time_control"])),
                report_language=ReportLanguage(str(data["report_language"])),
                contact=str(data["contact"]),
                rating=int(data["rating"]) if data.get("rating") is not None else None,
                player_name=str(data["player_name"]) if data.get("player_name") else None,
                idempotency_key=f"tg:{callback.from_user.id}:{data['draft_id']}",
            )
        )
    except ActiveOrderExists:
        await callback.message.answer(
            "У вас уже есть активное дело. Сначала завершите его; картотека не размножает "
            "одинаковые папки почкованием."
        )
        await callback.answer()
        return
    except CapacityExceeded:
        await callback.message.answer(
            "Суточный лимит исчерпан. Новое дело сегодня принять нельзя: качество не разменивается "
            "на конвейерную блевотину."
        )
        await callback.answer()
        return
    except DomainError as exc:
        await callback.message.answer(f"Карточка не зарегистрирована: {exc}")
        await callback.answer()
        return
    await state.clear()
    await callback.message.answer(
        f"Дело <b>{order.public_id}</b> зарегистрировано. Материалы будут запрошены после оплаты."
    )
    if settings.payment_mode == "telegram_stars":
        payment = await order_service.prepare_stars_payment(order.public_id, settings.star_price)
        await bot.send_invoice(
            chat_id=callback.from_user.id,
            title=f"{settings.brand_name}: заключение",
            description="PDF, четыре персональных PGN и план тренировки на 14 дней",
            payload=payment.invoice_payload,
            currency="XTR",
            prices=[LabeledPrice(label="Экспертиза партий", amount=settings.star_price)],
        )
    else:
        await callback.message.answer(
            "Сейчас включен ручной режим подтверждения оплаты. Платежные реквизиты сообщает "
            "администратор; бот не хранит карточные данные.",
            reply_markup=manual_payment_menu(order.public_id),
        )
    await notify_admins(bot, settings.admin_id_set, admin_card(order))
    await callback.answer()
