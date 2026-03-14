export type CliIntroOptions = {
  showAsciiBanner: boolean;
  version?: string;
  target?: string;
  pendingUpdateVersion?: string;
};

const ASCII_BANNER = [
  "     ██╗███████╗███╗   ██╗██╗  ██╗██╗███╗   ██╗███████╗",
  "     ██║██╔════╝████╗  ██║██║ ██╔╝██║████╗  ██║██╔════╝",
  "     ██║█████╗  ██╔██╗ ██║█████╔╝ ██║██╔██╗ ██║███████╗",
  "██   ██║██╔══╝  ██║╚██╗██║██╔═██╗ ██║██║╚██╗██║╚════██║",
  "╚█████╔╝███████╗██║ ╚████║██║  ██╗██║██║ ╚████║███████║",
  " ╚════╝ ╚══════╝╚═╝  ╚═══╝╚═╝  ╚═╝╚═╝╚═╝  ╚═══╝╚══════╝",
].join("\n");

/**
 * Build the CLI introduction text according to the provided options.
 *
 * @param options - Configuration that controls whether the ASCII banner is shown and supplies the CLI `version`, `target`, and an optional `pendingUpdateVersion`.
 * @returns The composed intro string:
 *  - First line is the ASCII banner when shown, otherwise "Jenkins CLI".
 *  - If present, a metadata line containing "CLI", the `version` (prefixed with `v` if not already), and the `target`, joined with " | ".
 *  - If present, a trailing line "Update available: vX" where `vX` is the pending update version prefixed with `v`.
 */
export function formatCliIntro(options: CliIntroOptions): string {
  const lines: string[] = [];

  if (options.showAsciiBanner) {
    lines.push(ASCII_BANNER);
  } else {
    lines.push("Jenkins CLI");
  }

  const metadata: string[] = [];
  if (options.showAsciiBanner) {
    metadata.push("CLI");
  }

  const version = normalizeVersionLabel(options.version);
  if (version) {
    metadata.push(version);
  }
  if (options.target) {
    metadata.push(options.target);
  }
  if (metadata.length > 0) {
    lines.push(metadata.join(" | "));
  }

  const pendingUpdateVersion = normalizeVersionLabel(
    options.pendingUpdateVersion,
  );
  if (pendingUpdateVersion) {
    lines.push(`Update available: ${pendingUpdateVersion}`);
  }

  return lines.join("\n");
}

/**
 * Prints the formatted CLI introduction followed by a blank line to the console.
 *
 * @param options - Configuration for the intro display (controls ASCII banner visibility, version/target metadata, and pending update version)
 */
export function printCliIntro(options: CliIntroOptions): void {
  console.log(formatCliIntro(options));
  console.log("");
}

/**
 * Normalize a version label to ensure it begins with 'v'.
 *
 * Trims surrounding whitespace and returns `null` when the input is undefined or empty after trimming.
 *
 * @param version - The version string to normalize
 * @returns The version prefixed with `v` if missing, or `null` when input is empty
 */
function normalizeVersionLabel(version: string | undefined): string | null {
  const trimmed = version?.trim();
  if (!trimmed) {
    return null;
  }
  return trimmed.startsWith("v") ? trimmed : `v${trimmed}`;
}
