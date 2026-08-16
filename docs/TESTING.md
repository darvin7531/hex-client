# Release testing

## Clean dependency install

После изменения dependency versions сначала обновите lock:

```powershell
Remove-Item -Recurse -Force node_modules -ErrorAction SilentlyContinue
Remove-Item package-lock.json -ErrorAction SilentlyContinue
npm install
```

После того как новый `package-lock.json` сохранён, обычная чистая проверка выполняется через:

```powershell
Remove-Item -Recurse -Force node_modules -ErrorAction SilentlyContinue
npm ci
```

## Mandatory checks

```powershell
npm run check
npm audit
```

`npm run check` выполняет:

- renderer TypeScript check;
- Vite production build;
- Electron TypeScript build;
- security regression tests.

## Dependency/toolchain gate

Текущий baseline:

- Node.js 24.18.1+ (24.x);
- npm 12.0.1+ (12.x);
- Electron 43.2.0;
- React 19.2.8;
- Vite 8.1.5;
- TypeScript 7.0.2;
- Tailwind CSS 4.3.3.

Проверяйте перед релизом:

```powershell
npm run check:toolchain
npm run deps:outdated
npm run deps:audit
```

`deps:outdated` требует доступа к npm registry. Если команда показывает новый stable release, сначала обновите и снова прогоните весь release test.

После любого major/minor обновления Electron обязательно smoke-test:

- запуск/закрытие/minimize/maximize;
- Settings;
- online bootstrap;
- offline bootstrap;
- install fresh pack;
- repair corrupted JAR;
- update pack with removed old mod;
- optional file toggle;
- `preserveUserChanges` config;
- Fabric launch;
- NeoForge launch;
- Forge fresh install + second launch from cache;
- auto-connect на Minecraft 1.20+ через Quick Play;
- legacy auto-connect на Minecraft 1.19.4 или ниже;
- server override on/off согласно `allowUserOverride`;
- stable/beta/test pack;
- выбор старой/архивной версии и восстановление выбора после restart;
- nickname history/select/remove;
- backend unavailable cached launch;
- malformed/tampered manifest rejection;
- optional and mandatory launcher update;
- second HexLoader instance focuses first instance instead of starting another sync process.


## Live backend contract

После запуска Go backend обязательно выполнить:

```powershell
npm run check:backend -- --url http://127.0.0.1:4000/api
```

Этот gate должен проходить перед релизом клиента и после любого изменения launcher-facing API backend. Он проверяет API major/capabilities, channels, version list, release manifests, server bootstrap, artifact policies и updater contract.

## Production signing gate

Before public release:

1. use HTTPS backend;
2. enable backend manifest SHA-256 + Ed25519;
3. pin manifest public key in client;
4. set `REQUIRE_SIGNED_MANIFESTS=true`;
5. sign NSIS installer using Authenticode;
6. pin certificate SHA-256 in client;
7. set `REQUIRE_AUTHENTICODE_INSTALLER=true`;
8. rebuild client after changing trust configuration;
9. test update from previous signed client build.

## Distribution build

Для локальной проверки NSIS:

```powershell
npm run dist:dev
```

Для production:

```powershell
npm run dist
```

Production команда дополнительно выполняет `scripts/check-production.mjs` и откажется собирать installer с EOL Electron, loopback/non-HTTPS backend, unsigned manifests или без pinned Authenticode certificate.

Do not distribute a build if `npm run check` or high/critical `npm audit` findings remain unresolved or explicitly reviewed.
