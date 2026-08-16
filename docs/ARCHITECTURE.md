# Client architecture

## Processes

```text
React renderer
    |
    | window.hexloaderDesktop
    v
sandboxed preload
    |
    | fixed IPC channels
    v
Electron main
    |-- backend/update validation
    |-- settings
    |-- updater
    |
    +--> launcher.cts
           |-- HTTP downloads
           |-- manifest trust
           |-- filesystem/storage
           |-- Java/Minecraft metadata
           |-- Minecraft process
```

Renderer не получает Node/Electron modules и не выбирает raw filesystem paths.

## Public client/backend flow

```text
bootstrap
  GET /api/launcher/version
  GET /api/packs
  GET /api/notices

pack
  GET /api/packs/:packId/versions?includeArchived=true
  GET /api/packs/:packId/latest?channel=<pack channel>
  или /releases/:version?channel=<pack channel>
       |
       +--> runtime contract validation
       +--> manifest hash/signature verification
       +--> same-origin source URL validation
       +--> sync managed files
       +--> write trusted local manifest
```

## Sync model

Локальная `.hexloader-release.json` — это trusted snapshot последней успешно синхронизированной release.

При обновлении:

1. server release валидируется;
2. old managed paths сравниваются с new release;
3. stale managed files удаляются;
4. `preserveUserChanges` не перезаписывается без необходимости;
5. selected optional files синхронизируются;
6. downloads проверяются до commit;
7. local release metadata записывается атомарно.

Файлы пользователя, которых никогда не было в managed manifest, не удаляются.

## Shared cache

Minecraft metadata/libraries/assets/Java хранятся отдельно от instance. Любой path, пришедший из Mojang/Fabric/NeoForge/Forge metadata, проходит containment/path validation перед использованием.

## Concurrency

Electron разрешает только один экземпляр HexLoader. IPC операции `sync`, `launch`, `delete`, `verify`, `diagnostics` сериализуются по `packId`.

Во время запущенного Minecraft mutation (`sync/delete`) запрещена.

## Loader support

- Fabric: native profile resolver;
- NeoForge: official Maven installer + generated version metadata;
- Forge: official Forge Installer `--installClient` + generated version metadata.

Loader installer downloads разрешены только с закреплённых официальных Maven hosts и должны пройти remote checksum verification до выполнения.
