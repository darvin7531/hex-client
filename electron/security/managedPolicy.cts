export type ManagedUpdatePolicy = "required_replace" | "required_keep_if_same" | "optional";

function sameHash(a?: string, b?: string) {
  return Boolean(a && b && a.toLowerCase() === b.toLowerCase());
}

export function shouldPreserveExistingManagedFile(input: {
  updatePolicy: ManagedUpdatePolicy;
  preserveUserChanges: boolean;
  currentHash?: string;
  previousHash?: string;
  expectedHash?: string;
}) {
  if (input.preserveUserChanges) return true;
  if (input.updatePolicy !== "required_keep_if_same") return false;
  if (!input.currentHash || !input.previousHash) return false;
  if (sameHash(input.currentHash, input.expectedHash)) return false;
  return !sameHash(input.currentHash, input.previousHash);
}

export function shouldVerifyManagedHash(updatePolicy: ManagedUpdatePolicy, preserveUserChanges: boolean) {
  return !preserveUserChanges && updatePolicy !== "required_keep_if_same";
}

export function shouldPreserveObsoleteManagedFile(updatePolicy: ManagedUpdatePolicy, preserveUserChanges: boolean) {
  return preserveUserChanges || updatePolicy === "required_keep_if_same";
}
