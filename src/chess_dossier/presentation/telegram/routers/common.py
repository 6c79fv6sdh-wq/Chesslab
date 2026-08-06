from __future__ import annotations

from html import escape

from aiogram import Router
from aiogram.filters import Command, CommandStart
from aiogram.fsm.context import FSMContext
from aiogram.types import CallbackQuery, Message

from chess_dossier.application.services import OrderService
from chess_dossier.config import Settings
from chess_dossier.presentation.telegram.callbacks import MenuCallback
from chess_dossier.presentation.telegram.keyboards import main_menu, source_menu
from chess_dossier.presentation.telegram.states import OrderIntake
from chess_dossier.presentation.telegram.texts import TERMS_TEXT, about_report, order_card, welcome

router = Router(name="common")


@router.message(CommandStart())
async def start(message: Message, state: FSMContext, settings: Settings) -> None:
    await state.clear()
    await message.answer(
        welcome(
            brand_name=settings.brand_name,
            price_rub=settings.display_price_rub,
            delivery_hours=settings.delivery_hours,
            max_daily_orders=settings.max_daily_orders,
        ),
        reply_markup=main_menu(),
    )


@router.message(Command("cancel"))
async def cancel(message: Message, state: FSMContext) -> None:
    await state.clear()
    await message.answer(
        "Операция прекращена. Карточка черновика уничтожена.", reply_markup=main_menu()
    )


@router.message(Command("help"))
async def help_command(message: Message, settings: Settings) -> None:
    await message.answer(
        about_report(max_games=settings.max_games_per_order), reply_markup=main_menu()
    )


@router.message(Command("terms"))
async def terms_command(message: Message) -> None:
    await message.answer(TERMS_TEXT)


@router.message(Command("support", "paysupport"))
async def support_command(message: Message, settings: Settings) -> None:
    await message.answer(
        "Вопросы по заказу и оплате принимает человек, а не метафизическая автоворонка:\n"
        f"{escape(settings.support_contact)}"
    )


@router.callback_query(MenuCallback.filter())
async def menu_action(
    callback: CallbackQuery,
    callback_data: MenuCallback,
    state: FSMContext,
    order_service: OrderService,
    settings: Settings,
) -> None:
    if callback.message is None:
        await callback.answer()
        return
    if callback_data.action == "new":
        import secrets

        await state.clear()
        await state.update_data(draft_id=secrets.token_hex(12))
        await state.set_state(OrderIntake.choosing_source)
        await callback.message.answer(
            "<b>ИСТОЧНИК МАТЕРИАЛОВ</b>\nВыберите, откуда будут получены партии.",
            reply_markup=source_menu(),
        )
    elif callback_data.action == "about":
        await callback.message.answer(about_report(max_games=settings.max_games_per_order))
    elif callback_data.action == "terms":
        await callback.message.answer(TERMS_TEXT)
    elif callback_data.action == "orders":
        if callback.from_user is None:
            await callback.answer()
            return
        orders = await order_service.list_user_orders(callback.from_user.id)
        if not orders:
            await callback.message.answer("В картотеке пока нет дел.")
        else:
            await callback.message.answer("\n\n".join(order_card(order) for order in orders))
    await callback.answer()
