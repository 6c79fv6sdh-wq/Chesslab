# Интеграция Chess Lab с основным сайтом ScienceChess

Мы готовим интеграцию Chess Lab с основным сайтом ScienceChess (репозиторий
`6c79fv6sdh-wq/vladchess-site`, GitHub Pages). Схема: Lab остаётся полностью
отдельным репозиторием и разрабатывается независимо, а на прод попадает
только его **готовая сборка** — она пушится в папку `lab/` внутри
`vladchess-site`, откуда GitHub Pages сам подхватывает и выкладывает её по
адресу `/lab/`. Исходники не смешиваются, только статические файлы после
билда.

Чтобы это заработало, в репозитории Lab нужно сделать четыре вещи.

## 1. Base path в конфиге сборщика

Если Vite — в `vite.config`:

```js
export default {
  base: '/lab/',
  build: { outDir: 'dist' } // если outDir другой — учтите это в workflow ниже
}
```

Без этого пути к JS/CSS после деплоя будут вести не туда и всё будет битым.

## 2. Клиентский роутинг (если есть)

Если внутри Lab есть клиентский роутинг (React Router и подобное) — выставить
`basename="/lab"` тем же принципом. Если роутинг на хэшах (`#/exercise/5`)
или страница вообще одна — этот пункт неважен, можно пропустить.

## 3. Файл `.github/workflows/deploy.yml` в репозитории Lab

```yaml
name: Publish to main site
on:
  push:
    tags: ['v*']        # публикуем по релизным тегам, не на каждый коммит
  workflow_dispatch: {}  # и вручную кнопкой в Actions, когда нужно

jobs:
  build-and-publish:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20 }
      - run: npm ci
      - run: npm run build

      - name: Push build into vladchess-site /lab/
        env:
          TOKEN: ${{ secrets.VLADCHESS_SITE_TOKEN }}
        run: |
          git clone https://x-access-token:${TOKEN}@github.com/6c79fv6sdh-wq/vladchess-site.git target
          rm -rf target/lab
          mkdir -p target/lab
          cp -r dist/* target/lab/
          cd target
          git config user.name "sciencechess-lab bot"
          git config user.email "actions@users.noreply.github.com"
          git add lab
          git diff --cached --quiet && exit 0
          git commit -m "Update /lab/ from sciencechess-lab@${GITHUB_SHA::7}"
          git push
```

Если вместо npm используется yarn/pnpm — поменяйте только команды
установки/сборки, остальное без изменений.

## 4. Токен для пуша в чужой репозиторий

Нужен fine-grained Personal Access Token:

1. GitHub → **Settings** → **Developer settings** → **Personal access tokens**
   → **Fine-grained tokens** → **New token**.
2. Repository access: **Only select repositories** → выбрать
   `6c79fv6sdh-wq/vladchess-site`.
3. Permissions → **Contents: Read and write**.
4. **Generate token**.
5. Положить токен в репозиторий Lab: **Settings** → **Secrets and variables**
   → **Actions** → **New repository secret** → имя `VLADCHESS_SITE_TOKEN`,
   значение — сам токен.

Это единственный шаг, который нельзя автоматизировать — токен создаёт
человек в интерфейсе GitHub, ни один ассистент не может сделать это за вас.

## После настройки

Сделать первый релизный тег:

```
git tag v0.1.0
git push --tags
```

Сборка сама уедет в `vladchess-site/lab/`, и раздел будет виден по адресу
`https://6c79fv6sdh-wq.github.io/vladchess-site/lab/` — домен `vladches.ru`
подключать отдельно не нужно, это никак не связано с доменом.

## Что сообщить обратно

Когда это будет готово и первый релиз уедет — просто сказать «Lab выложен».
Дальше добавится ссылка `<a href="lab/">` на главной странице в нужном месте
меню. Больше ничего для этого не требуется — со стороны основного сайта
архитектура уже готова.
