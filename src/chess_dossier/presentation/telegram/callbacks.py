from aiogram.filters.callback_data import CallbackData


class MenuCallback(CallbackData, prefix="menu"):
    action: str


class IntakeCallback(CallbackData, prefix="intake"):
    field: str
    value: str


class PaymentCallback(CallbackData, prefix="payment"):
    action: str
    order_id: str
