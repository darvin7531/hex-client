export type LibraryResolutionDecision = "use-local" | "download" | "reinstall-loader";

export function decideLibraryResolution(input: {
  localExists: boolean;
  declaredHashMatches: boolean;
  declaredSizeMatches: boolean;
  hasExplicitDownloadUrl: boolean;
}): LibraryResolutionDecision {
  const localValid = input.localExists && input.declaredHashMatches && input.declaredSizeMatches;
  if (localValid) return "use-local";
  if (input.hasExplicitDownloadUrl) return "download";
  return "reinstall-loader";
}
