# HexLoader Client

Windows-лаунчер HexLoader на Electron + React + TypeScript. Клиент работает с HexLoader Go Backend, синхронизирует Minecraft-сборки, проверяет целостность файлов, управляет Java runtime и запускает Minecraft.

## Что изменено в hardened v2

Критическая логика вынесена из renderer в Electron main process. Renderer больше не имеет произвольного доступа к файловой системе, процессам или сетевой конфигурации. Preload экспортирует только узкий `window.hexloaderDesktop` API.

Основные изменения:

- `contextIsolation`, Electron sandbox, отключённый Node integration и webview;
- блокировка внешней навигации, popup-окон, permission requests и обычных Electron downloads;
- проверка sender каждого IPC вызова;
- один экземпляр лаунчера и последовательные операции над одной сборкой;
- runtime-валидация всех ответов backend;
- HTTPS обязателен для внешнего backend, HTTP допускается только на loopback в development;
- pack-файлы скачиваются только с origin backend;
- SHA-256 проверяется до атомарной замены существующего файла;
- старый рабочий файл сохраняется при неудачной замене;
- Windows-safe пути, защита от traversal, reserved names, symlink/junction и case-insensitive collisions;
- безопасная распаковка Java/native ZIP с лимитами размера, количества entries и compression ratio;
- удаление устаревших managed-файлов между версиями;
- поддержка `optional` и `preserveUserChanges`;
- offline запуск только из уже установленного и повторно проверенного cache;
- malformed backend response или ошибка подписи **не** превращаются в offline fallback;
- настоящий progress скачивания вместо декоративного таймера;
- optional Ed25519 verification manifest;
- updater требует SHA-256; дополнительно умеет pin Authenticode certificate;
- updater не выполняет произвольные аргументы от backend;
- правильный Minecraft offline UUID;
- Fabric, NeoForge и Forge install/launch;
- release channels `stable` / `beta` / `test` читаются у каждой конкретной версии из `/versions`; клиент не подменяет канал hardcoded `stable`;
- выбор и сохранение конкретной версии сборки, включая архивные версии; выбранная версия запрашивается с её собственным release channel;
- MOTD и server bootstrap из backend;
- user server override только когда backend разрешил `allowUserOverride`;
- современный auto-connect через Quick Play для Minecraft 1.20+ и legacy args для старых версий;
- история сохранённых ников с быстрым переключением;
- live backend↔launcher contract checker (`npm run check:backend`);
- Fabric, NeoForge и Forge поддерживаются. Forge устанавливается официальным headless Forge Installer и проверяется до запуска.

Подробная матрица backend ↔ launcher: [docs/LAUNCHER_PARITY.md](docs/LAUNCHER_PARITY.md).

## Требования

- Windows x64;
- Node.js для разработки/сборки;
- npm;
- работающий HexLoader Go Backend.

Проект закреплён на актуальном стабильном toolchain: Electron 43.2.0, React 19.2.8, Vite 8.1.5, TypeScript 7.0.2 и Tailwind 4.3.3. Подробности в [docs/TESTING.md](docs/TESTING.md).

## Установка зависимостей

Для этой обновлённой версии старый lock-файл намеренно удалён, потому что он фиксировал устаревший dependency tree. Первый раз выполните:

```powershell
npm install
```

После этого npm создаст новый `package-lock.json`. Его нужно сохранить в репозитории; последующие чистые установки снова выполняются через:

```powershell
npm ci
```

Для сборки используйте Node.js 24.18.1+ в пределах ветки 24.x и npm 12.0.1+ в пределах ветки 12.x. Версия Node зафиксирована в `.nvmrc` и `.node-version`, npm — в `packageManager`/`devEngines`.

## Development

```powershell
npm run dev
```

Vite слушает только `127.0.0.1:3000`.

## Проверка

```powershell
npm run check
```

Команда выполняет TypeScript/Vite build, компиляцию Electron main/preload и security regression tests.

Дополнительно:

```powershell
npm run deps:outdated
npm run deps:audit
```

При запущенном backend проверьте именно живой launcher-контракт:

```powershell
npm run check:backend -- --url http://127.0.0.1:4000/api
```

Проверка проходит `/launcher/version`, capabilities, packs, channels, versions, release manifests, Java requirements, server bootstrap, artifact policies и launcher updater.

`package.json` использует точные версии прямых зависимостей. `npm run check:toolchain` проверяет, что установлены именно они. Dependabot настроен на еженедельную проверку обновлений.

## Production backend

Откройте `electron/sharedConfig.cts` и задайте backend:

```ts
export const DEFAULT_API_BASE = "https://launcher.example.com/api";
```

В production пользовательская смена API выключена по умолчанию. `HEXLOADER_API_BASE` и поле custom API применяются только в development, если `ALLOW_CUSTOM_API_IN_PRODUCTION` явно не включён в build.

### Manifest signing

Для production рекомендуется включить Ed25519 signing на backend.

На backend:

```powershell
.\hex-backend.exe keygen-signing
```

Private key хранится только на backend:

```env
HEXLOADER_MANIFEST_HASH_MODE=sha256
HEXLOADER_SIGNING_PRIVATE_KEY=<private-key-base64>
```

Public key закрепляется внутри client build:

```ts
export const MANIFEST_SIGNING_PUBLIC_KEY_BASE64 = "<public-key-base64>";
export const REQUIRE_SIGNED_MANIFESTS = true;
```

После этого unsigned/tampered manifest не запускается даже из локального cache.

### Authenticode updater pin

После настройки code signing для Windows installer можно закрепить SHA-256 fingerprint сертификата:

```ts
export const INSTALLER_SIGNER_CERT_SHA256 = "<64 hex chars>";
export const REQUIRE_AUTHENTICODE_INSTALLER = true;
```

Тогда обновление принимается только если одновременно совпадает SHA-256 файла от backend и Windows считает Authenticode signature валидной и выпущенной закреплённым сертификатом.

## Сборка

Локальный/test installer без production trust-gate:

```powershell
npm run dist:dev
```

Production installer:

```powershell
npm run check
npm run dist
```

`npm run dist` намеренно завершится ошибкой, пока не выполнены production требования: поддерживаемый Electron, HTTPS backend, обязательная Ed25519-подпись manifest и pinned Authenticode certificate. Это защита от случайного выпуска compatibility build. NSIS installer создаёт `electron-builder`.

## Структура

```text
electron/
  main.cts                  privileged Electron process + IPC + updater
  preload.cts               narrow renderer bridge
  launcher.cts              Minecraft/download/storage/runtime logic
  sharedConfig.cts          build-time trust configuration
  security/
    validation.cts          paths/URLs/input validation
    contracts.cts           backend runtime contracts
    manifestSignature.cts   SHA-256/Ed25519 verification
    *.test.cts              security regression tests

src/
  components/               React UI
  lib/clientApi.ts          renderer API facade
  electron.d.ts             exact preload bridge types

docs/
  ARCHITECTURE.md
  TESTING.md
```

## Данные пользователя

Настройки хранятся в Electron `userData/client-settings.json`. Minecraft instances, shared cache, runtimes и launcher logs создаются внутри каталога данных HexLoader. Renderer не получает прямых путей для произвольной записи.

Синхронизация сборки транзакционная: новые файлы сначала скачиваются и проверяются в staging, затем применяются одним commit-проходом. Если commit ломается посередине, изменённые файлы откатываются. В интерфейсе есть живой журнал текущего запуска с фильтрацией по уровню и scope.

## Ограничения

- Manifest signing и Authenticode pin находятся в compatibility mode, пока вы не закрепите реальные production keys/certificate.
- Не включайте `ALLOW_CUSTOM_API_IN_PRODUCTION`, если не требуется специальный тестовый build.

См. также [SECURITY.md](SECURITY.md).
