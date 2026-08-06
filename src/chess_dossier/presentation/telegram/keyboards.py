from __future__ import annotations

from aiogram.types import (
    InlineKeyboardButton,
    InlineKeyboardMarkup,
    KeyboardButton,
    ReplyKeyboardMarkup,
)

from chess_dossier.domain.enums import ReportLanguage, SourceType, TimeControl
from chess_dossier.presentation.telegram.callbacks import (
    IntakeCallback,
    MenuCallback,
    PaymentCallback,
)


def main_menu() -> InlineKeyboardMarkup:
    return InlineKeyboardMarkup(
        inline_keyboard=[
            [
                InlineKeyboardButton(
                    text="Открыть дело", callback_data=MenuCallback(action="new").pack()
                )
            ],
            [
                InlineKeyboardButton(
                    text="Состав заключения", callback_data=MenuCallback(action="about").pack()
                ),
                InlineKeyboardButton(
                    text="Мои дела", callback_data=MenuCallback(action="orders").pack()
                ),
            ],
            [
                InlineKeyboardButton(
                    text="Регламент", callback_data=MenuCallback(action="terms").pack()
                )
            ],
        ]
    )


def source_menu() -> InlineKeyboardMarkup:
    return InlineKeyboardMarkup(
        inline_keyboard=[
            [
                InlineKeyboardButton(
                    text="Lichess",
                    callback_data=IntakeCallback(
                        field="source", value=SourceType.LICHESS.value
                    ).pack(),
                ),
                InlineKeyboardButton(
                    text="PGN-файл",
                    callback_data=IntakeCallback(field="source", value=SourceType.PGN.value).pack(),
                ),
            ],
            [
                InlineKeyboardButton(
                    text="Chess.com через PGN",
                    callback_data=IntakeCallback(
                        field="source", value=SourceType.CHESSCOM_PGN.value
                    ).pack(),
                )
            ],
        ]
    )


def rating_skip() -> InlineKeyboardMarkup:
    return InlineKeyboardMarkup(
        inline_keyboard=[
            [
                InlineKeyboardButton(
                    text="Не указывать",
                    callback_data=IntakeCallback(field="rating", value="skip").pack(),
                )
            ]
        ]
    )


def time_control_menu() -> InlineKeyboardMarkup:
    return InlineKeyboardMarkup(
        inline_keyboard=[
            [
                InlineKeyboardButton(
                    text="Блиц",
                    callback_data=IntakeCallback(
                        field="time", value=TimeControl.BLITZ.value
                    ).pack(),
                ),
                InlineKeyboardButton(
                    text="Рапид",
                    callback_data=IntakeCallback(
                        field="time", value=TimeControl.RAPID.value
                    ).pack(),
                ),
            ],
            [
                InlineKeyboardButton(
                    text="Блиц + рапид",
                    callback_data=IntakeCallback(field="time", value=TimeControl.BOTH.value).pack(),
                )
            ],
        ]
    )


def language_menu() -> InlineKeyboardMarkup:
    return InlineKeyboardMarkup(
        inline_keyboard=[
            [
                InlineKeyboardButton(
                    text="Русский",
                    callback_data=IntakeCallback(
                        field="language", value=ReportLanguage.RU.value
                    ).pack(),
                ),
                InlineKeyboardButton(
                    text="English",
                    callback_data=IntakeCallback(
                        field="language", value=ReportLanguage.EN.value
                    ).pack(),
                ),
            ]
        ]
    )


def contact_menu() -> ReplyKeyboardMarkup:
    return ReplyKeyboardMarkup(
        keyboard=[[KeyboardButton(text="Передать мой контакт", request_contact=True)]],
        resize_keyboard=True,
        one_time_keyboard=True,
        input_field_placeholder="Телефон, @username или другой контакт",
    )


def review_menu() -> InlineKeyboardMarkup:
    return InlineKeyboardMarkup(
        inline_keyboard=[
            [
                InlineKeyboardButton(
                    text="Согласен с регламентом — открыть дело",
                    callback_data=IntakeCallback(field="review", value="confirm").pack(),
                )
            ],
            [
                InlineKeyboardButton(
                    text="Отменить",
                    callback_data=IntakeCallback(field="review", value="cancel").pack(),
                )
            ],
        ]
    )


def manual_payment_menu(public_id: str) -> InlineKeyboardMarkup:
    return InlineKeyboardMarkup(
        inline_keyboard=[
            [
                InlineKeyboardButton(
                    text="Сообщить об оплате",
                    callback_data=PaymentCallback(action="reported", order_id=public_id).pack(),
                )
            ]
        ]
    )
