# Avito Messenger Relay

Nest.js сервис, который через Puppeteer входит в Личный кабинет Авито,
слушает сообщения от заданного пользователя (например, «Рушан Натфуллин») и
транслирует их клиенту в реальном времени по WebSocket.

## Архитектура

```
                           Avito web
                              │
                     Puppeteer (DOM) + CDP (WS)
                              │
      ┌───────────────────────┴───────────────────────┐
      │  Nest.js (port 3000)                          │
      │                                               │
      │  AvitoModule                                  │
      │    BrowserService     — Chromium lifecycle    │
      │    AuthService        — login + 2FA gate      │
      │    ChatWatcherService — DOM scan + WS frames  │
      │      └─ message-frame.parser  (contract)      │
      │                │                              │
      │                │ EventEmitter2                │
      │                ▼                              │
      │  StatusService  ─  snapshot store             │
      │                │                              │
      │                ▼                              │
      │  MessagesGateway  ─ socket.io ─────► browser  │
      │                                               │
      │  HTTP endpoints:                              │
      │    POST /auth/code     AuthController         │
      │    GET  /status        StatusController       │
      │                                               │
      │  ServeStatic ─► client/{index.html, app.js}   │
      └───────────────────────────────────────────────┘
```

### Ключевые решения

- **Сессия через `userDataDir`** — Chromium хранит куки в `./.chrome-profile`,
  повторные запуски не требуют логина и снижают шанс CAPTCHA.
- **Гибридная авторизация** — если сессия не валидна, сервис логинится из
  `.env`. Проверка сессии делается одним снимком DOM: есть
  `[data-marker="header/menu-profile"]` → авторизованы. Это профильное меню
  в шапке Avito, оно рендерится на любой странице сайта при активной сессии.
  Если нет — старая Page закрывается и для логина открывается свежий таб через
  `browser.newPage()` (куки живут в `userDataDir` на уровне браузер-контекста,
  не на странице). Это убирает гонку с клиент-сайдным редиректом Avito на
  `/#login` и выкидывает stale SPA-стейт.
- **Детект исхода логина — по событиям, не по URL** — после сабмита формы
  гонка из двух промисов, зарегистрированных **до** клика: `waitForNavigation`
  (любой реальный cross-document переход → success) и
  `waitForSelector(codeInput)` (модалка 2FA → переходим в ветку с вводом
  кода). Если за 60с ни одно — `error`. Аналогично после ввода 2FA: успех =
  факт навигации.
- **Семантика `auth:code_accepted`** — событие летит фронту **только после**
  того, как Avito приняла код (post-2FA `waitForNavigation` отстрелял). HTTP
  `POST /auth/code` возвращает `{ received: true }` сразу, но это лишь «код
  получили» — реальное подтверждение приходит отдельным WS-событием.
- **Получение сообщений через CDP** — слушаем `Network.webSocketFrameReceived`
  от `wss://socket.avito.ru` и парсим фреймы с дискриминатором `type === "Message"`.
  Парсер изолирован в `message-frame.parser.ts` и строго валидирует контракт
  (`value.id`, `value.channelId`, `body.text` для текстовых, timestamp). При
  поломке формата watcher вызывает `halt()` и переходит в `state=error` —
  лучше явно остановиться, чем молча терять сообщения.
- **Только новые после старта** — сообщения с `createdAt < startTime`
  отбрасываются; дедуп по `value.id` через in-memory `Set` (триммится до 2500
  при превышении 5000).
- **Таргет-чат** — `TARGET_USER_NAME` ищется как case-insensitive подстрока в
  именах диалогов. Список обновляется реактивно через `MutationObserver` на
  корне списка плюс safety-таймер раз в 60 секунд (на случай навигаций,
  отвязывающих observer).
- **Health monitor** — тот же 60-секундный таймер проверяет, что страница не
  закрыта и что по WS приходят фреймы. Если за 90с не было ни одного фрейма
  (включая Avito keepalive-пинги) — halt() с `WS stalled: …`.
- **StatusService как единая правда о состоянии** — подписан на доменные
  события (`status.change`, `auth.needs_code`, `auth.code_accepted`), хранит
  snapshot `{ status, awaitingCode }`. `MessagesGateway` читает его для
  replay новым клиентам, `StatusController` отдаёт по `GET /status`. Так и
  gateway, и HTTP-эндпоинт согласованы из одного источника.
- **Stealth** — `puppeteer-extra-plugin-stealth` плюс набор `--disable-…`
  флагов, чтобы снизить обнаружение автоматизации.
- **Graceful shutdown** — `app.enableShutdownHooks()` + `OnModuleDestroy` в
  `BrowserService` и `ChatWatcherService` (CDP detach, page close, очистка
  таймеров) корректно завершают работу при `SIGTERM/SIGINT`.

## Структура проекта

```
src/
  main.ts                 — bootstrap, dotenv, ValidationPipe, shutdown hooks
  app.module.ts           — корневой модуль, ServeStatic, EventEmitter
  config/                 — типизированный конфиг из ENV
  modules/
    avito/
      avito.module.ts
      browser.service.ts        — лайфсайкл Chromium
      auth.service.ts           — логин + 2FA шлюз
      chat-watcher.service.ts   — DOM-скан, WS-перехват, health monitor
      message-frame.parser.ts   — pure-парсер + валидация WS-фреймов
      avito.types.ts            — кросс-модульные типы
    status/
      status.module.ts
      status.service.ts         — агрегатор событий, snapshot store
      status.controller.ts      — GET /status
    messages/
      messages.module.ts
      messages.gateway.ts       — socket.io: broadcast + replay
      auth.controller.ts        — POST /auth/code
      auth-code.dto.ts
client/
  index.html, styles.css, app.js — фронтенд
```

## События WebSocket

| Событие             | Направление | Полезная нагрузка                                                                |
| ------------------- | ----------- | -------------------------------------------------------------------------------- |
| `status:change`     | server→client | `{ state, detail?, at }` где `state ∈ idle / starting / logging_in / awaiting_code / authorized / error` |
| `auth:needs_code`   | server→client | `{ reason, at }` — Авито запросил 2FA                                            |
| `auth:code_accepted`| server→client | `{ at }` — Avito подтвердила код (произошла навигация после ввода 2FA).          |
| `message:new`       | server→client | `{ id, chatId, authorName, text, createdAt, receivedAt }`                        |

REST:

- `POST /auth/code` принимает `{ "code": "123456" }`. В ответе `{ received: boolean }`
  — это «код доставлен в Puppeteer», а не «Avito приняла». Подтверждение приёма
  приходит отдельным WS-событием `auth:code_accepted`. `400`, если в данный
  момент 2FA не запрошена.
- `GET /status` отдаёт snapshot `{ status, awaitingCode }` — тот же, что
  gateway шлёт новым клиентам. До старта авторизации `status.state = 'idle'`.

## Запуск (локально)

### 1. Установка

```bash
node --version    # ≥ 20
npm install
```

При первой установке Puppeteer скачает совместимый Chromium (~170 MB).
Если у вас уже есть Chrome, можно указать его в `.env`:

```env
PUPPETEER_EXECUTABLE_PATH=/Applications/Google Chrome.app/Contents/MacOS/Google Chrome
```

### 2. Конфигурация

Скопируйте `.env.example` → `.env` и заполните:

```env
PORT=3000

AVITO_LOGIN=+7 999 123-45-67
AVITO_PASSWORD=your-password
TARGET_USER_NAME=Рушан

PUPPETEER_HEADLESS=false        # рекомендуется false при первом запуске
PUPPETEER_USER_DATA_DIR=./.chrome-profile

AUTH_MAX_ATTEMPTS=3
```

### 3. Старт

```bash
npm run start:dev
```

Откройте <http://localhost:3000>. На странице:

- индикатор статуса вверху;
- если Авито запросит SMS-код — появится поле ввода кода;
- при появлении сообщений в целевом чате они мгновенно отрисуются.

> **Совет на первый запуск:** оставьте `PUPPETEER_HEADLESS=false` и при
> необходимости вручную пройдите CAPTCHA в открывшемся окне Chromium. После
> этого сессия сохранится в `.chrome-profile`, и следующие запуски можно
> делать в `headless=true`.

## Docker

```bash
docker compose up --build
```

> Образ основан на `ghcr.io/puppeteer/puppeteer`, который содержит готовый
> Chromium. В Docker `PUPPETEER_HEADLESS=true` форсится в compose-файле.
> Профиль Chromium живёт в named-volume `chrome-profile` (не на хосте) —
> сессия переживает `docker compose restart`/`down → up`. Локальный
> `.chrome-profile` контейнером не используется. Первый запуск контейнера
> = чистая сессия: сервис залогинится из `.env`, 2FA-код введёшь в форме
> на `localhost:3000`. Дальше — сессия осядет в volume.

## Публикация через CloudPub

Чтобы поделиться демо без публичного IP, поднимаем туннель `clo` (CloudPub)
рядом с запущенным сервисом на `localhost:3000`.

### 1. Регистрация

1. Откройте <https://cloudpub.ru> и зарегистрируйтесь (email + пароль).
2. В личном кабинете → раздел «Установка» → скопируйте токен.

### 2. Установка (Linux x86_64, Ubuntu/Debian)

```bash
# Скачать актуальную версию
wget https://cloudpub.ru/download/stable/clo-3.0.1-stable-linux-x86_64.tar.gz

# Распаковать
tar -xzf clo-3.0.1-stable-linux-x86_64.tar.gz

# Установить в систему
sudo install -m 755 clo /usr/local/bin/clo

# Проверить
clo --version
```

### 3. Привязка токена

```bash
clo set token <ВАШ_ТОКЕН>
```

Токен сохраняется в `~/.cloudpub/` и подхватывается автоматически.

### 4. Публикация сервиса

```bash
clo publish http 3000
```

В выводе появится публичный URL вида `https://xxxxx.cloudpub.ru` — открывайте
его в браузере с любого устройства, фронт и WebSocket работают как с
`localhost:3000`.

## Обработка ошибок

| Сценарий                          | Поведение сервиса                                                                                                          |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Неверный пароль / нет 2FA-кода    | До `AUTH_MAX_ATTEMPTS` попыток с backoff. Между попытками `state` остаётся `logging_in` (без мерцания на `error`), причина последней неудачи попадает в `detail` финального `status:error`. |
| Disconnect Chromium               | `BrowserService` подхватит на следующем запросе и перезапустится.                                                          |
| Контракт Avito сломался (DOM / WS)| Watcher вызывает `halt()`, эмитит `status.change` с `state=error` и причиной в `detail`. Нужен перезапуск после починки.   |
| WS-стрим встал (нет фреймов 90с+) | Health-monitor вызывает `halt()` с `WS stalled: …` — поднимается тем же путём, что и другие halt-причины.                  |
| Закрытие страницы                 | Health-monitor детектит `page.isClosed()` и вызывает `halt()`; перезапуск процесса восстановит состояние.                  |
| `SIGINT`/`SIGTERM`                | `OnModuleDestroy` закрывает CDP, страницу, чистит таймеры.                                                                 |
