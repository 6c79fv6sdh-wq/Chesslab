from __future__ import annotations

from dataclasses import dataclass
from html import escape

from chess_dossier.domain.enums import OrderStatus, ReportLanguage, SourceType, TimeControl
from chess_dossier.domain.models import Order


@dataclass(frozen=True, slots=True)
class Terminology:
    order: str = "дело"
    order_plural: str = "дела"
    source: str = "материалы дела"
    analysis: str = "экспертиза"
    report: str = "заключение"
    queue: str = "реестр производства"
    admin: str = "дежурный архивариус"


TERMS = Terminology()


def welcome(*, brand_name: str, price_rub: int, delivery_hours: int, max_daily_orders: int) -> str:
    return (
        f"<b>{escape(brand_name.upper())}</b>\n"
        "Отдел шахматной экспертизы\n\n"
        "Мы не пересказываем оценку движка. Мы устанавливаем повторяющиеся дефекты решений, "
        "перепроверяем критические позиции и превращаем выводы в персональную тренировку.\n\n"
        "<b>В составе заключения</b>\n"
        "• доказательный PDF-отчет;\n"
        "• ошибки за белых и черных;\n"
        "• позиции на реализацию за оба цвета;\n"
        "• план работы на 14 дней.\n\n"
        f"Тариф: <b>{price_rub} ₽</b>. Срок: до <b>{delivery_hours} часов</b>. "
        f"В производство принимается не более {max_daily_orders} дел в сутки."
    )


def about_report(*, max_games: int) -> str:
    return (
        "<b>СОСТАВ ЗАКЛЮЧЕНИЯ</b>\n\n"
        "1. Корпус партий и прозрачные знаменатели.\n"
        "2. Быстрый движковый проход и повторная проверка критических позиций.\n"
        "3. Повторяющиеся паттерны ошибок без психологических гаданий по кофейной гуще.\n"
        "4. PDF с доказательствами и ссылками на партии.\n"
        "5. Четыре PGN: ошибки и реализация, отдельно за белых и черных.\n"
        "6. Практический план на 14 дней.\n\n"
        f"Для первого запуска принимается до {max_games} партий. "
        "Chess.com — через экспортированный PGN."
    )


TERMS_TEXT = (
    "<b>РЕГЛАМЕНТ</b>\n\n"
    "Услуга представляет аналитическое заключение по предоставленным шахматным партиям. "
    "Срок отсчитывается после оплаты и получения пригодных материалов. "
    "Автоматическая оценка движка проверяется человеком; абсолютная безошибочность любой "
    "аналитической системы не гарантируется. Возврат и исправление рассматриваются через /support."
)

STATUS_LABELS: dict[OrderStatus, str] = {
    OrderStatus.AWAITING_PAYMENT: "ожидает оплаты",
    OrderStatus.PAYMENT_REVIEW: "платеж на проверке",
    OrderStatus.PAID: "оплачено",
    OrderStatus.AWAITING_SOURCE: "ожидаются материалы",
    OrderStatus.QUEUED: "внесено в реестр",
    OrderStatus.IN_PROGRESS: "идет экспертиза",
    OrderStatus.REVIEW_PENDING: "ожидает проверки экспертом",
    OrderStatus.READY: "заключение готово",
    OrderStatus.DELIVERED: "материалы вручены",
    OrderStatus.FAILED: "требуется вмешательство",
    OrderStatus.CANCELED: "дело закрыто",
}

SOURCE_LABELS: dict[SourceType, str] = {
    SourceType.LICHESS: "Lichess-профиль",
    SourceType.PGN: "PGN-файл",
    SourceType.CHESSCOM_PGN: "Chess.com через PGN",
}

TIME_LABELS: dict[TimeControl, str] = {
    TimeControl.BLITZ: "блиц",
    TimeControl.RAPID: "рапид",
    TimeControl.BOTH: "блиц + рапид",
}

LANGUAGE_LABELS: dict[ReportLanguage, str] = {
    ReportLanguage.RU: "русский",
    ReportLanguage.EN: "английский",
}


def intake_review(
    data: dict[str, object], *, price_rub: int, stars_amount: int | None = None
) -> str:
    source = SourceType(str(data["source_type"]))
    time_control = TimeControl(str(data["time_control"]))
    language = ReportLanguage(str(data["report_language"]))
    rating = data.get("rating")
    rating_text = str(rating) if rating is not None else "не указан"
    player_name = str(data.get("player_name") or "будет взят из Lichess-профиля")
    price = (
        f"<b>{stars_amount} ⭐</b> (расчетный тариф {price_rub} ₽)"
        if stars_amount is not None
        else f"<b>{price_rub} ₽</b>"
    )
    return (
        "<b>РЕГИСТРАЦИОННАЯ КАРТОЧКА</b>\n\n"
        f"Источник: {SOURCE_LABELS[source]}\n"
        f"Игрок: {escape(player_name)}\n"
        f"Рейтинг: {escape(rating_text)}\n"
        f"Контроль: {TIME_LABELS[time_control]}\n"
        f"Язык: {LANGUAGE_LABELS[language]}\n"
        f"Контакт: {escape(str(data['contact']))}\n\n"
        f"К оплате: {price}. После подтверждения оплаты бот запросит материалы.\n\n"
        "Нажимая кнопку регистрации, вы принимаете /terms."
    )


def source_prompt(order: Order) -> str:
    if order.source_type == SourceType.LICHESS:
        instruction = "Пришлите ник или ссылку вида https://lichess.org/@/username."
    else:
        instruction = "Пришлите один PGN-файл. В нем должно быть от 1 до 50 партий."
    return (
        f"<b>ДЕЛО {escape(order.public_id)}</b>\n"
        "Оплата подтверждена. Теперь требуются материалы.\n\n"
        f"{instruction}"
    )


def order_card(order: Order) -> str:
    games = str(order.game_count) if order.game_count is not None else "—"
    return (
        f"<b>{escape(order.public_id)}</b>\n"
        f"Статус: {STATUS_LABELS[order.status]}\n"
        f"Источник: {SOURCE_LABELS[order.source_type]}\n"
        f"Контроль: {TIME_LABELS[order.time_control]}\n"
        f"Игрок: {escape(order.player_name or '—')}\n"
        f"Рейтинг: {order.rating or '—'}\n"
        f"Партий: {games}\n"
        f"Контакт: {escape(order.contact)}"
    )


def admin_card(order: Order) -> str:
    source = order.source_reference or order.source_original_name or "материалы еще не получены"
    failure = f"\nСбой: <code>{escape(order.failure_reason)}</code>" if order.failure_reason else ""
    return (
        f"<b>КАРТОЧКА ДЕЛА {escape(order.public_id)}</b>\n"
        f"Клиент: <code>{order.telegram_user_id}</code>\n"
        f"Статус: {STATUS_LABELS[order.status]}\n"
        f"Источник: {SOURCE_LABELS[order.source_type]} / {escape(source)}\n"
        f"Контроль: {TIME_LABELS[order.time_control]}\n"
        f"Игрок: {escape(order.player_name or '—')}\n"
        f"Рейтинг: {order.rating or '—'}\n"
        f"Партий: {order.game_count or '—'}\n"
        f"Контакт: {escape(order.contact)}{failure}\n\n"
        f"Команды: <code>/paid {escape(order.public_id)}</code> · "
        f"<code>/take {escape(order.public_id)}</code> · "
        f"<code>/preview {escape(order.public_id)}</code> · "
        f"<code>/retry {escape(order.public_id)}</code> · "
        f"<code>/deliver {escape(order.public_id)}</code>"
    )
