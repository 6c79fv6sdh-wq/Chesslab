# Контрольная точка 0.2.0 — 2026-08-06

## 1. Цель проекта

Проверить спрос на платное доказательное шахматное заключение: первые 10–20 оплаченных дел по
990 ₽, до 50 партий, срок до 24 часов и не более трех новых дел в сутки. Клиент получает
машинный манифест, PDF с планом на 14 дней и четыре учебных PGN по цвету и типу задачи.

## 2. Что сделано

- восстановлен полный Telegram concierge: анкета, оплата, прием источника, очередь, аудит и выдача;
- реализован bounded Lichess export и прием PGN/Chess.com PGN;
- реализован двухпроходный Stockfish pipeline с player-POV, `Clear Hash`, дедупликацией и тегами;
- считаются прозрачные метрики по фазам и конверсии порогов +2/+3/+5;
- создаются schema-versioned `analysis.json`, доказательный PDF и четыре oriented position-PGN;
- worker работает вне event loop, фиксирует сбои и допускает безопасный retry;
- введен обязательный human-review gate `review_pending`, команды `/preview` и `/retry`;
- сохранена ручная подмена файлов и возобновляемая at-least-once доставка;
- Docker runtime содержит Stockfish/DejaVu и устанавливается по замороженному `uv.lock`.

## 3. Созданные файлы

Основное новое ядро: `src/chess_dossier/analysis/*`,
`src/chess_dossier/application/analysis_worker.py`,
`src/chess_dossier/infrastructure/analysis/{stockfish,lichess}.py` и Telegram notifier/review-команды.
Контракт и эксплуатация: `docs/ANALYSIS_SPEC.md`, обновленные `ARCHITECTURE.md`, `OPERATIONS.md`,
`SECURITY.md`, `CHANGELOG.md`. Данные: миграция `0002_player_name.py`. Проверки: worker, Lichess,
pipeline, PDF/PGN и SQLite tests. В `examples/demo_games.pgn` лежит безопасный smoke-корпус.

## 4. Последняя завершенная операция

Полный локальный контроль релиза: форматирование, Ruff, strict mypy по 54 source-файлам, 32 теста,
цикл Alembic `upgrade → downgrade → upgrade`, dispatcher smoke-test, два чистых запуска настоящего
Stockfish 18, генерация шести файлов, текстовая и постраничная визуальная проверка четырехстраничного
PDF. Собраны wheel и sdist версии 0.2.0.

## 5. Незавершенная операция

Живой end-to-end через Telegram и сборка Docker-образа здесь не выполнены: отсутствуют токен,
`ADMIN_IDS` владельца и Docker CLI. Код не притворяется, что внешняя инфраструктура уже проверена.

## 6. Следующий минимальный шаг

Владелец заполняет `.env`, выполняет `docker compose build`, `alembic upgrade head` и проводит один
тестовый заказ до `/preview → /deliver → /done`. После него фиксируются только реальные UX-дефекты;
архитектурного переписывания для запуска не требуется.
