from aiogram.fsm.state import State, StatesGroup


class OrderIntake(StatesGroup):
    choosing_source = State()
    entering_player_name = State()
    entering_rating = State()
    choosing_time_control = State()
    choosing_language = State()
    entering_contact = State()
    reviewing = State()


class AdminDelivery(StatesGroup):
    collecting_files = State()
