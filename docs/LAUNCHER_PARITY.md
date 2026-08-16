# Backend ↔ Launcher parity

Этот файл фиксирует launcher-facing контракт HexLoader Backend API 2.1 и hardened client. Admin API сюда не входит: он предназначен для Admin UI, а не для игрового клиента.

## Public endpoints

| Backend endpoint | Launcher consumer | Назначение |
|---|---|---|
| `GET /api/health` | monitoring/deployment | Operational endpoint. Игровой клиент намеренно не зависит от health-check. |
| `GET /api/launcher/version` | Electron main/bootstrap | API/capability negotiation, maintenance mode, published launcher version. |
| `GET /api/launcher/update?platform=win32` | Electron main updater | Проверенный `.exe`/`.msi`, SHA-256, mandatory, notes, safe silent args. |
| `GET /api/notices` | launcher dashboard | Глобальные объявления. |
| `GET /api/packs` | launcher dashboard | Только packs с published release; карточка описывает immutable snapshot реально опубликованной latest version. |
| `GET /api/packs/{packId}/versions` | PackView | Выбор published/archived версии и release channel каждой версии. |
| `GET /api/packs/{packId}/latest?channel=...` | launcher core | Последний опубликованный release указанного канала. |
| `GET /api/packs/{packId}/releases/{version}?channel=...` | launcher core | Конкретная опубликованная версия с её каналом. |

## Release fields

| Поле/группа | Launcher behavior |
|---|---|
| `Fabric` | Fabric profile metadata → Mojang base metadata → install/sync/launch. |
| `NeoForge` | Official NeoForge installer in headless client mode → generated version metadata/libraries → launch. |
| `Forge` | Official MinecraftForge installer `--installClient` → generated version metadata/libraries → launch. |
| `javaRequirements` | Managed Temurin Windows x64 runtime. Vendor metadata checksum обязателен; backend SHA pin используется, если задан. |
| `files[].sha256` | Проверяется до commit в instance. |
| `required_replace` | Рабочий файл приводится к опубликованной версии. |
| `required_keep_if_same` | Обновляется только неизменённый пользователем файл; пользовательское изменение сохраняется. |
| `optional` | Пользователь выбирает файл в PackView; выбор сохраняется per-pack. |
| `preserveUserChanges` | Существующий пользовательский файл не перезаписывается обычной синхронизацией и не удаляется как obsolete. |
| `serverBootstrap.autoConnect` | MC 1.20+ использует Quick Play multiplayer; старые версии используют legacy server/port arguments. |
| `serverBootstrap.allowUserOverride` | Пользовательский host/port разрешён только при `true`; main process повторно применяет policy перед launch. |
| `serverBootstrap.motd` | Показывается в PackView. |
| `releaseChannel` | Берётся у конкретной версии; `stable/beta/test` не подменяются hardcoded channel. |
| `archived` | Версия доступна в version selector, но помечена archived. |
| `changelog` | Показывается в PackView. |
| `manifestHash` / `signature` | Проверка legacy/SHA-256/Ed25519 policy до доверия release manifest. |
| `stateMachine` | Compatibility vocabulary: клиент валидирует, что backend знает обязательные launcher states; фактическое runtime-state хранит клиент. |
| `diagnostics` | Compatibility vocabulary, подписанная вместе с manifest. Реальные runtime diagnostics собираются клиентом локально. |

## Local client features

Эти функции не требуют backend endpoint и поэтому не должны появляться как server capabilities: nickname + history, RAM, resolution, fullscreen, offline UUID, selected version, selected optional files, server override values, logs и cached offline launch.

## Intentional compatibility fields

`minimumSupportedBackend` остаётся в JSON ради legacy shape, но hardened client определяет совместимость через `backendApiVersion` + обязательные `capabilities`.

## Regression gate

При поднятом backend клиент должен проходить:

```text
npm run check:backend -- --url http://127.0.0.1:4000/api
```

Checker валидирует capabilities, notices, pack summaries, `/versions`, каждый release/channel, artifact policies, server bootstrap и launcher updater contract.
