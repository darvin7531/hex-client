"use strict";

import https from "node:https";
import http from "node:http";
import fsp from "node:fs/promises";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import AdmZip from "adm-zip";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type InstallPhase = "java" | "fabric" | "files" | "done" | "error";

export type InstallProgress = {
  phase: InstallPhase;
  percent: number; // 0-100 overall
  message: string;
};

export type PackFileSpec = {
  path: string;
  size: number;
  sha256: string;
  sourceUrl: string;
};

export type InstallParams = {
  packId: string;
  javaVersion: number;
  loaderType: string;
  loaderVersion: string;
  minecraftVersion: string;
  files: PackFileSpec[];
};

type ProgressCb = (ev: InstallProgress) => void;

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

function downloadFile(
  url: string,
  destPath: string,
  onProgress?: (downloaded: number, total: number) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const attempt = (currentUrl: string, redirects = 0) => {
      if (redirects > 10) {
        reject(new Error(`Too many redirects: ${url}`));
        return;
      }
      const mod = currentUrl.startsWith("https") ? https : http;
      mod
        .get(currentUrl, (res) => {
          if (res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 307) {
            attempt(res.headers.location!, redirects + 1);
            return;
          }
          if (res.statusCode && res.statusCode >= 400) {
            reject(new Error(`HTTP ${res.statusCode} for ${currentUrl}`));
            return;
          }
          const total = parseInt(res.headers["content-length"] ?? "0", 10);
          let downloaded = 0;
          const fileStream = fs.createWriteStream(destPath);
          res.on("data", (chunk: Buffer) => {
            downloaded += chunk.length;
            onProgress?.(downloaded, total);
          });
          res.pipe(fileStream);
          fileStream.on("finish", () => fileStream.close(() => resolve()));
          fileStream.on("error", (err) => {
            fsp.unlink(destPath).catch(() => {});
            reject(err);
          });
        })
        .on("error", reject);
    };
    attempt(url);
  });
}

async function fetchJson<T>(url: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const attempt = (currentUrl: string, redirects = 0) => {
      if (redirects > 5) {
        reject(new Error(`Too many redirects: ${url}`));
        return;
      }
      const mod = currentUrl.startsWith("https") ? https : http;
      mod
        .get(currentUrl, (res) => {
          if (res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 307) {
            attempt(res.headers.location!, redirects + 1);
            return;
          }
          let body = "";
          res.setEncoding("utf8");
          res.on("data", (chunk: string) => {
            body += chunk;
          });
          res.on("end", () => {
            try {
              resolve(JSON.parse(body) as T);
            } catch (e) {
              reject(new Error(`Failed to parse JSON from ${currentUrl}: ${String(e)}`));
            }
          });
        })
        .on("error", reject);
    };
    attempt(url);
  });
}

// ---------------------------------------------------------------------------
// SHA-256 helpers
// ---------------------------------------------------------------------------

async function sha256File(filePath: string): Promise<string> {
  const buf = await fsp.readFile(filePath);
  return createHash("sha256").update(buf).digest("hex");
}

async function sha256Matches(filePath: string, expected: string): Promise<boolean> {
  if (!expected) return true; // no checksum to verify
  try {
    const actual = await sha256File(filePath);
    return actual === expected;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Maven coordinate → relative path
// ---------------------------------------------------------------------------

function mavenToRelPath(coord: string): string {
  // "net.fabricmc:fabric-loader:0.16.10"
  // → "net/fabricmc/fabric-loader/0.16.10/fabric-loader-0.16.10.jar"
  const parts = coord.split(":");
  if (parts.length < 3) throw new Error(`Invalid maven coord: ${coord}`);
  const [group, artifact, version] = parts;
  const groupPath = group.replace(/\./g, "/");
  return `${groupPath}/${artifact}/${version}/${artifact}-${version}.jar`;
}

// ---------------------------------------------------------------------------
// Java — Adoptium Temurin JRE
// ---------------------------------------------------------------------------

interface AdoptiumPackage {
  link: string;
  checksum: string;
  size: number;
}

interface AdoptiumAsset {
  binary: {
    package: AdoptiumPackage;
    image_type: string;
  };
  release_name: string;
}

/**
 * Ensures Temurin JRE of the given major version is installed.
 * Returns path to java.exe.
 * Progress: 0 → 30
 */
export async function getJavaExecutable(
  majorVersion: number,
  runtimesDir: string,
  emit: ProgressCb,
): Promise<string> {
  const javaDir = path.join(runtimesDir, `temurin-${majorVersion}`);
  const javaExe = path.join(javaDir, "bin", "java.exe");

  if (fs.existsSync(javaExe)) {
    emit({ phase: "java", percent: 30, message: `Java ${majorVersion} уже установлена` });
    return javaExe;
  }

  emit({ phase: "java", percent: 0, message: `Запрашиваю Adoptium API для Java ${majorVersion}…` });

  const apiUrl =
    `https://api.adoptium.net/v3/assets/latest/${majorVersion}/hotspot` +
    `?os=windows&arch=x64&image_type=jre`;

  const assets = await fetchJson<AdoptiumAsset[]>(apiUrl);
  const asset = assets[0];
  if (!asset) throw new Error(`Java ${majorVersion} не найдена в Adoptium`);

  const { link, checksum, size } = asset.binary.package;
  const sizeMb = Math.round(size / 1024 / 1024);

  emit({ phase: "java", percent: 2, message: `Скачиваю Java ${majorVersion} (${sizeMb} MB)…` });

  await fsp.mkdir(runtimesDir, { recursive: true });
  const zipPath = path.join(runtimesDir, `temurin-${majorVersion}-download.zip`);

  await downloadFile(link, zipPath, (dl, total) => {
    const pct = total > 0 ? 2 + Math.round((dl / total) * 23) : 2;
    const dlMb = Math.round(dl / 1024 / 1024);
    const totalMb = Math.round(total / 1024 / 1024);
    emit({ phase: "java", percent: pct, message: `Java ${majorVersion}: ${dlMb} / ${totalMb} MB` });
  });

  emit({ phase: "java", percent: 26, message: "Проверяю контрольную сумму Java…" });
  if (checksum && !(await sha256Matches(zipPath, checksum))) {
    await fsp.unlink(zipPath);
    throw new Error("Контрольная сумма Java-архива не совпадает");
  }

  emit({ phase: "java", percent: 27, message: "Распаковываю Java…" });

  // Snapshot directory listing before extraction to detect new entry
  const before = new Set(await fsp.readdir(runtimesDir));
  const zip = new AdmZip(zipPath);
  zip.extractAllTo(runtimesDir, true);
  await fsp.unlink(zipPath);

  const after = await fsp.readdir(runtimesDir);
  const newEntry = after.find((e) => !before.has(e));
  if (newEntry) {
    const src = path.join(runtimesDir, newEntry);
    const stat = await fsp.stat(src);
    if (stat.isDirectory()) {
      await fsp.rename(src, javaDir).catch(() => {});
    }
  }

  if (!fs.existsSync(javaExe)) {
    throw new Error(`java.exe не найден после установки (ожидался: ${javaExe})`);
  }

  emit({ phase: "java", percent: 30, message: `Java ${majorVersion} установлена` });
  return javaExe;
}

// ---------------------------------------------------------------------------
// Fabric loader — libraries via Fabric meta API
// ---------------------------------------------------------------------------

interface FabricLibrary {
  name: string;
  url: string;
  sha1?: string;
  size?: number;
}

interface FabricProfile {
  id: string;
  libraries: FabricLibrary[];
  mainClass: string;
}

/**
 * Downloads Fabric loader libraries.
 * Returns classpath entries (absolute paths).
 * Progress: 30 → 60
 */
export async function installFabric(
  mcVersion: string,
  loaderVersion: string,
  librariesDir: string,
  emit: ProgressCb,
): Promise<{ classpath: string[]; mainClass: string; profileId: string }> {
  emit({ phase: "fabric", percent: 30, message: "Запрашиваю Fabric meta API…" });

  const profileUrl =
    `https://meta.fabricmc.net/v2/versions/loader/${mcVersion}/${loaderVersion}/profile/json`;
  const profile = await fetchJson<FabricProfile>(profileUrl);

  const total = profile.libraries.length;
  const classpath: string[] = [];

  for (let i = 0; i < total; i++) {
    const lib = profile.libraries[i];
    const relPath = mavenToRelPath(lib.name);
    const destPath = path.join(librariesDir, relPath);
    const libUrl = lib.url.replace(/\/$/, "") + "/" + relPath;

    classpath.push(destPath);

    if (fs.existsSync(destPath)) continue; // already downloaded

    await fsp.mkdir(path.dirname(destPath), { recursive: true });

    const pct = 30 + Math.round(((i + 1) / total) * 29);
    const shortName = lib.name.split(":")[1] ?? lib.name;
    emit({ phase: "fabric", percent: pct, message: `Fabric ${i + 1}/${total}: ${shortName}` });

    await downloadFile(libUrl, destPath);
  }

  emit({ phase: "fabric", percent: 60, message: `Fabric ${loaderVersion} для MC ${mcVersion} установлен` });
  return { classpath, mainClass: profile.mainClass, profileId: profile.id };
}

// ---------------------------------------------------------------------------
// Pack files (mods, configs, etc.)
// ---------------------------------------------------------------------------

/**
 * Downloads pack files listed in the release manifest.
 * Skips files whose SHA-256 already matches.
 * Progress: 60 → 100
 */
export async function downloadPackFiles(
  files: PackFileSpec[],
  instanceDir: string,
  emit: ProgressCb,
): Promise<void> {
  const actionable = files.filter((f) => f.sourceUrl);
  const total = actionable.length;

  if (total === 0) {
    emit({ phase: "files", percent: 100, message: "Файлы сборки не требуют обновления" });
    return;
  }

  let done = 0;
  for (const file of actionable) {
    const destPath = path.join(instanceDir, file.path);

    // Skip if exists and hash matches
    if (fs.existsSync(destPath)) {
      const ok = await sha256Matches(destPath, file.sha256);
      if (ok) {
        done++;
        continue;
      }
    }

    await fsp.mkdir(path.dirname(destPath), { recursive: true });

    done++;
    const pct = 60 + Math.round((done / total) * 40);
    emit({
      phase: "files",
      percent: pct,
      message: `Файл ${done}/${total}: ${path.basename(file.path)}`,
    });

    await downloadFile(file.sourceUrl, destPath);
  }

  emit({ phase: "files", percent: 100, message: `Все ${total} файлов сборки актуальны` });
}

// ---------------------------------------------------------------------------
// Full install pipeline
// ---------------------------------------------------------------------------

export async function runInstall(
  params: InstallParams,
  dataDir: string,
  emit: ProgressCb,
): Promise<void> {
  const runtimesDir = path.join(dataDir, "runtimes");
  const librariesDir = path.join(dataDir, "libraries");
  const instanceDir = path.join(dataDir, "instances", params.packId);

  // 1. Java (0-30%)
  await getJavaExecutable(params.javaVersion, runtimesDir, emit);

  // 2. Loader (30-60%)
  if (params.loaderType === "Fabric") {
    await installFabric(params.minecraftVersion, params.loaderVersion, librariesDir, emit);
  } else {
    // NeoForge / Forge — placeholder, mark fabric phase as skipped
    emit({ phase: "fabric", percent: 60, message: `${params.loaderType} — автоустановка не реализована, пропускаю` });
  }

  // 3. Pack files (60-100%)
  await downloadPackFiles(params.files, instanceDir, emit);

  emit({ phase: "done", percent: 100, message: "Установка завершена" });
}
