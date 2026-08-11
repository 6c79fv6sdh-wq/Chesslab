# sciencechess-lab-gate

Cloudflare Worker: проверяет код доступа ScienceChess Lab и выдаёт
подписанный короткоживущий токен. Полная документация — раздел «Доступ»
в README корня репозитория (архитектура, rate limiting, CORS, команды
деплоя и смены кода).

Коротко:

```bash
npm install
npx wrangler login
npx wrangler kv namespace create RATE_LIMIT_KV   # id → в wrangler.toml
node tools/generate-key.mjs                      # запускай сам, не в чате
npx wrangler secret put ACCESS_CODE
npx wrangler secret put SIGNING_PRIVATE_KEY_JWK
npx wrangler deploy
```

Локальная разработка: `cp .dev.vars.example .dev.vars`, заполни своими
тестовыми значениями, `npm run dev`.
