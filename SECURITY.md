# HexLoader Client Security

## Trust model

Renderer считается потенциально недоверенным. Он отвечает за отображение UI, но не должен напрямую:

- читать/писать произвольные файлы;
- запускать процессы;
- выбирать произвольные URL загрузок;
- самостоятельно считать backend response доверенным;
- передавать raw `ipcRenderer` наружу.

Все привилегированные действия выполняются Electron main process / `launcher.cts` через ограниченный preload API.

## Backend trust

В development разрешён loopback HTTP. В production backend должен использовать HTTPS.

Pack artifact URL обязан иметь тот же origin, что и configured backend. Redirects для pack artifact downloads запрещены.

Для production рекомендуется:

1. `HEXLOADER_MANIFEST_HASH_MODE=sha256` на backend;
2. Ed25519 signing private key только на backend;
3. public key pinned в `electron/sharedConfig.cts`;
4. `REQUIRE_SIGNED_MANIFESTS=true` в client build.

Compatibility `legacy` manifest hash следует считать переходным режимом, а не полноценной криптографической защитой.

## File integrity

Pack artifact принимается только после проверки:

- безопасного managed path;
- declared size;
- SHA-256;
- отсутствия symlink/junction escape;
- принадлежности configured instance root.

Замена файла выполняется через временный файл. При ошибке старый файл восстанавливается или backup остаётся на диске для recovery.

## Archive handling

ZIP entries проверяются до/во время extraction:

- traversal;
- Windows reserved names;
- symlink entries;
- existing symlink/junction components;
- duplicate/case-collision paths;
- entry count;
- unpacked size;
- per-entry size;
- compression ratio.

## Offline mode

Offline fallback разрешён только для реальной сетевой недоступности backend. Protocol errors, malformed JSON, invalid SHA/signature и аномальный backend response остаются hard failure.

Перед cached launch manifest и managed files проверяются повторно.

## Updater

Launcher installer:

- должен находиться на backend origin;
- скачивается во временный файл;
- имеет size limit;
- обязан совпасть с SHA-256 из update manifest;
- может дополнительно требовать valid Authenticode + pinned signing certificate;
- получает только allow-listed silent installer flags;
- запускается без shell.

Для production включите `REQUIRE_AUTHENTICODE_INSTALLER=true` после настройки code signing.

## Electron hardening

Production BrowserWindow использует:

- `sandbox: true`;
- `contextIsolation: true`;
- `nodeIntegration: false`;
- `webSecurity: true`;
- `allowRunningInsecureContent: false`;
- `webviewTag: false`;
- DevTools disabled;
- denied popup/navigation/permissions/downloads;
- sender validation for IPC.

`electron-builder` включает restrictive Electron fuses, в том числе ASAR integrity и `onlyLoadAppFromAsar`.

## Supported toolchain

Production baseline сейчас закреплён на Electron 43.2.0 (Node 24.x внутри Electron), Vite 8.1.5 и TypeScript 7.0.2. Перед релизом выполните `npm ci`, `npm run check`, `npm run deps:outdated`, `npm run deps:audit` и тестовый NSIS build. `@types/node` намеренно остаётся на последней ветке 24.x, чтобы соответствовать Node runtime Electron, а не формально самому новому major Node types.

## Reporting

При обнаружении проблемы не публикуйте production private signing keys, installer certificates/keys, backend admin key или пользовательские instance data в issue/log bundle.
