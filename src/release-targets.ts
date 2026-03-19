export type SupportedRuntimePlatform = "darwin" | "linux" | "win32";
export type SupportedRuntimeArch = "x64" | "arm64";
export type LinuxLibc = "gnu" | "musl";

export type NativeReleaseTarget = {
  compileTarget: string;
  assetName: string;
  platform: SupportedRuntimePlatform;
  arch: SupportedRuntimeArch;
  libc?: LinuxLibc;
  homebrewTarballName?: string;
};

export const LEGACY_BUNDLE_ASSET_NAME = "jenkins-cli";
export const LEGACY_BUNDLE_BUILD_TARGET = "bun-bundle";

export const NATIVE_RELEASE_TARGETS: NativeReleaseTarget[] = [
  {
    compileTarget: "bun-linux-x64",
    assetName: "jenkins-cli-linux-x64",
    platform: "linux",
    arch: "x64",
    libc: "gnu",
    homebrewTarballName: "jenkins-cli-linux-x64.tar.gz",
  },
  {
    compileTarget: "bun-linux-x64-musl",
    assetName: "jenkins-cli-linux-x64-musl",
    platform: "linux",
    arch: "x64",
    libc: "musl",
  },
  {
    compileTarget: "bun-linux-arm64",
    assetName: "jenkins-cli-linux-arm64",
    platform: "linux",
    arch: "arm64",
    libc: "gnu",
    homebrewTarballName: "jenkins-cli-linux-arm64.tar.gz",
  },
  {
    compileTarget: "bun-linux-arm64-musl",
    assetName: "jenkins-cli-linux-arm64-musl",
    platform: "linux",
    arch: "arm64",
    libc: "musl",
  },
  {
    compileTarget: "bun-darwin-x64",
    assetName: "jenkins-cli-darwin-x64",
    platform: "darwin",
    arch: "x64",
    homebrewTarballName: "jenkins-cli-darwin-x64.tar.gz",
  },
  {
    compileTarget: "bun-darwin-arm64",
    assetName: "jenkins-cli-darwin-arm64",
    platform: "darwin",
    arch: "arm64",
    homebrewTarballName: "jenkins-cli-darwin-arm64.tar.gz",
  },
  {
    compileTarget: "bun-windows-x64",
    assetName: "jenkins-cli-windows-x64.exe",
    platform: "win32",
    arch: "x64",
  },
];

export const HOMEBREW_RELEASE_TARGETS = NATIVE_RELEASE_TARGETS.filter(
  (target): target is NativeReleaseTarget & { homebrewTarballName: string } =>
    typeof target.homebrewTarballName === "string",
);

export function isSupportedRuntimePlatform(
  platform: string,
): platform is SupportedRuntimePlatform {
  return platform === "darwin" || platform === "linux" || platform === "win32";
}

export function isSupportedRuntimeArch(
  arch: string,
): arch is SupportedRuntimeArch {
  return arch === "x64" || arch === "arm64";
}

export function resolveNativeReleaseTarget(options: {
  platform: string;
  arch: string;
  libc?: LinuxLibc;
}): NativeReleaseTarget | null {
  const { platform, arch } = options;
  if (!isSupportedRuntimePlatform(platform) || !isSupportedRuntimeArch(arch)) {
    return null;
  }

  if (platform === "linux") {
    const libc = options.libc === "musl" ? "musl" : "gnu";
    return (
      NATIVE_RELEASE_TARGETS.find(
        (target) =>
          target.platform === platform &&
          target.arch === arch &&
          (target.libc ?? "gnu") === libc,
      ) ?? null
    );
  }

  return (
    NATIVE_RELEASE_TARGETS.find(
      (target) =>
        target.platform === platform &&
        target.arch === arch &&
        target.libc === undefined,
    ) ?? null
  );
}

export function isLegacyBundleBuildTarget(buildTarget: string): boolean {
  return buildTarget.trim().toLowerCase() === LEGACY_BUNDLE_BUILD_TARGET;
}
