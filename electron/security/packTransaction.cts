import { promises as fs } from "node:fs";
import path from "node:path";
import { safeJoinManaged } from "./validation.cjs";

export type PathSafetyCheck = (root: string, candidate: string) => Promise<void>;

type PackTransactionRecord = {
  relativePath: string;
  targetPath: string;
  backupPath: string;
  hadOriginal: boolean;
  installedNew: boolean;
};

export class PackRollbackIncompleteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PackRollbackIncompleteError";
  }
}

async function exists(filePath: string) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function ensureDir(dirPath: string) {
  await fs.mkdir(dirPath, { recursive: true });
}

export async function commitPackTransaction(
  instanceDir: string,
  transactionRoot: string,
  stagedPaths: readonly string[],
  obsoletePaths: readonly string[],
  assertSafePath: PathSafetyCheck,
) {
  const newRoot = path.join(transactionRoot, "new");
  const backupRoot = path.join(transactionRoot, "backup");
  const stagedKeys = new Set(stagedPaths.map((value) => value.toLowerCase()));
  const deletionPaths = obsoletePaths.filter((value) => !stagedKeys.has(value.toLowerCase()));
  const operations = [
    ...stagedPaths.map((relativePath) => ({ relativePath, installNew: true })),
    ...deletionPaths.map((relativePath) => ({ relativePath, installNew: false })),
  ];
  const records: PackTransactionRecord[] = [];
  const removedPaths: string[] = [];

  try {
    for (const operation of operations) {
      const targetPath = safeJoinManaged(instanceDir, operation.relativePath);
      const backupPath = safeJoinManaged(backupRoot, operation.relativePath);
      const stagedPath = safeJoinManaged(newRoot, operation.relativePath);
      await assertSafePath(instanceDir, targetPath);
      await assertSafePath(transactionRoot, backupPath);
      if (operation.installNew) await assertSafePath(transactionRoot, stagedPath);

      const hadOriginal = await exists(targetPath);
      const record: PackTransactionRecord = {
        relativePath: operation.relativePath,
        targetPath,
        backupPath,
        hadOriginal,
        installedNew: false,
      };
      records.push(record);

      if (hadOriginal) {
        await ensureDir(path.dirname(backupPath));
        await fs.rename(targetPath, backupPath);
      }
      if (operation.installNew) {
        await ensureDir(path.dirname(targetPath));
        await fs.rename(stagedPath, targetPath);
        record.installedNew = true;
      } else if (hadOriginal) {
        removedPaths.push(operation.relativePath);
      }
    }
    return { removedPaths };
  } catch (error) {
    const rollbackErrors: string[] = [];
    for (const record of records.reverse()) {
      try {
        if (record.installedNew && (await exists(record.targetPath))) {
          await fs.rm(record.targetPath, { force: true });
        }
        if (record.hadOriginal && (await exists(record.backupPath))) {
          await ensureDir(path.dirname(record.targetPath));
          if (await exists(record.targetPath)) await fs.rm(record.targetPath, { force: true });
          await fs.rename(record.backupPath, record.targetPath);
        }
      } catch (rollbackError) {
        rollbackErrors.push(
          `${record.relativePath}: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
        );
      }
    }
    if (rollbackErrors.length) {
      throw new PackRollbackIncompleteError(
        `Pack transaction failed and rollback was incomplete. Recovery data was kept at ${transactionRoot}. ` +
        `Rollback errors: ${rollbackErrors.join("; ")}. Original error: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    throw error;
  }
}

export async function cleanupOldPackTransactions(
  instanceDir: string,
  assertSafePath: PathSafetyCheck,
  except?: string,
) {
  let entries: import("node:fs").Dirent[] = [];
  try {
    entries = await fs.readdir(instanceDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.name.startsWith(".hexloader-txn-") || !entry.isDirectory() || entry.isSymbolicLink()) continue;
    const candidate = path.join(instanceDir, entry.name);
    if (except && path.resolve(candidate) === path.resolve(except)) continue;
    await assertSafePath(instanceDir, candidate);
    await fs.rm(candidate, { recursive: true, force: true });
  }
}
