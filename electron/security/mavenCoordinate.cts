export type ParsedMavenCoordinate = {
  group: string;
  artifact: string;
  version: string;
  classifier: string;
  extension: string;
};

function assertCoordinatePart(value: string, label: string) {
  if (!value || value.length > 256 || !/^[A-Za-z0-9_.+\-]+$/.test(value)) {
    throw new Error(`Invalid Maven ${label}: ${value || "<empty>"}`);
  }
  return value;
}

export function parseMavenCoordinate(name: string): ParsedMavenCoordinate {
  if (typeof name !== "string" || !name || name.length > 1024) {
    throw new Error("Invalid Maven coordinate");
  }
  const at = name.lastIndexOf("@");
  const coordinate = at >= 0 ? name.slice(0, at) : name;
  const extension = assertCoordinatePart(at >= 0 ? name.slice(at + 1) : "jar", "extension");
  const parts = coordinate.split(":");
  if (parts.length !== 3 && parts.length !== 4) {
    throw new Error(`Unsupported Maven coordinate: ${name}`);
  }
  const [groupRaw, artifactRaw, versionRaw, classifierRaw = ""] = parts;
  const group = assertCoordinatePart(groupRaw, "group");
  const artifact = assertCoordinatePart(artifactRaw, "artifact");
  const version = assertCoordinatePart(versionRaw, "version");
  const classifier = classifierRaw ? assertCoordinatePart(classifierRaw, "classifier") : "";
  return { group, artifact, version, classifier, extension };
}

export function mavenPathFromCoordinate(name: string) {
  const { group, artifact, version, classifier, extension } = parseMavenCoordinate(name);
  const base = `${group.replace(/\./g, "/")}/${artifact}/${version}`;
  return `${base}/${artifact}-${version}${classifier ? `-${classifier}` : ""}.${extension}`;
}

export function mavenIdentity(name: string) {
  const { group, artifact, classifier, extension } = parseMavenCoordinate(name);
  return `${group}:${artifact}:${classifier}@${extension}`.toLowerCase();
}
