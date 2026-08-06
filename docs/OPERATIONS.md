# Эксплуатация

## Локальная разработка

```bash
cp .env.example .env
uv sync --extra dev
uv run alembic upgrade head
uv run chess-dossier
```

Используйте `ENVIRONMENT=development` и `PAYMENT_MODE=manual`. `AUTO_CREATE_SCHEMA=true` допустим
только для одноразовой песочницы; нормальный запуск всегда проходит через Alembic.

Для worker-а установите UCI-совместимый Stockfish, укажите исполняемый файл в `STOCKFISH_PATH` и
включите `ANALYSIS_ENABLED=true`. При неверном пути конфигурация останавливает процесс до приема
заказов. Шрифт DejaVu Sans или Liberation Sans обязателен для кириллического PDF.

Проверка аналитического ядра без Telegram:

```bash
uv run chess-dossier-analyze \
  --pgn examples/demo_games.pgn \
  --player DemoPlayer \
  --output ./demo-output \
  --stockfish /usr/games/stockfish
```

## Production

- `ENVIRONMENT=production`;
- `PAYMENT_MODE=telegram_stars` и положительный `STAR_PRICE`;
- `REDIS_URL`, `ADMIN_IDS`, `SUPPORT_CONTACT` и токен заданы явно;
- `ANALYSIS_ENABLED=true`, Stockfish и Unicode-шрифты присутствуют;
- `AUTO_CREATE_SCHEMA=false`, перед стартом выполнен `alembic upgrade head`;
- БД и `STORAGE_ROOT` резервируются как единый набор.

Docker Compose устанавливает Stockfish, DejaVu и включает анализ:

```bash
docker compose build
docker compose run --rm bot alembic upgrade head
docker compose up -d
docker compose logs -f bot
```

SQLite допустим только для одной реплики, где polling и worker находятся в одном процессе. Перед
второй репликой или отдельным worker-ом нужен PostgreSQL и атомарный claim очереди. Два polling-
инстанса с одним Telegram-токеном также запрещены.

## Админские команды

- `/admin` — активные и аварийные дела;
- `/order ID` — карточка и причина последнего сбоя;
- `/paid ID` — ручное подтверждение только в development;
- `/take ID` — взять queued/failed-дело в полностью ручную работу;
- `/preview ID` — получить автокомплект себе без отметок клиентской доставки;
- `/retry ID` — вернуть failed/зависшее автоматическое дело в очередь;
- `/deliver ID` — закрепить комплект за собой и открыть замену файлов;
- `/done` — повторно проверить комплект, отправить и зафиксировать delivery;
- `/abort_delivery` — закрыть режим загрузки без удаления файлов.

Штатный автоматический путь: `queued → in_progress → review_pending`. После `/preview` эксперт либо
запускает `/deliver ID` и `/done`, либо заменяет конкретные файлы перед `/done`.

## Аварии и восстановление

При ошибке Lichess, PGN, Stockfish, PDF или хранилища worker переводит дело в `failed`, сохраняет
краткую причину и уведомляет администраторов. После устранения причины `/retry ID` запускает полный
pipeline заново; артефакты upsert-ятся по типу, поэтому полупакет не может стать готовым комплектом.

Если процесс остановлен во время анализа, дело может остаться `in_progress` без администратора.
После рестарта администратор проверяет отсутствие живого worker-а для этого дела и выполняет
`/retry ID`. Автоматически гадать, умер ли движок или еще считает, система сознательно не пытается.

Если Telegram оборвал выдачу, снова выполните `/deliver ID`, затем `/done`. Метки
`artifacts.delivered_at` позволяют пропустить уже отправленные файлы. Замена файла сбрасывает его
метку, и новая версия будет отправлена.

## Контроль релиза

```bash
uv run ruff format --check .
uv run ruff check .
uv run mypy src
uv run pytest

export DATABASE_URL=sqlite+aiosqlite:////tmp/chess-dossier-migration.db
uv run alembic upgrade head
uv run alembic downgrade base
uv run alembic upgrade head

uv build
```

Дополнительно выполните CLI-прогон настоящим Stockfish и отрендерите PDF через `pdftoppm`; сигнатура
`%PDF` сама по себе не доказывает, что таблицы читаются и доски ориентированы правильно.

## Резервирование

Ежедневно сохраняйте БД и `data/storage` вместе. После завершенной стадии делайте Git-коммит и
архив исходников без `.env`, БД, пользовательских PGN и токенов. Период хранения клиентских данных
должен быть определен владельцем до продаж.
