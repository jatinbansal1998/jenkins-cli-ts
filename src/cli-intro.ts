type CliIntroOptions = {
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

export function formatCliIntro(options: CliIntroOptions): string {
  const lines: string[] = [];

  if (options.showAsciiBanner) {
    lines.push("\n", ASCII_BANNER, "\n");
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

export function printCliIntro(
  options: CliIntroOptions,
  write: (text: string) => void = (text) => process.stderr.write(text),
): void {
  write(`${formatCliIntro(options)}\n`);
}

function normalizeVersionLabel(version: string | undefined): string | null {
  const trimmed = version?.trim();
  if (!trimmed) {
    return null;
  }
  return trimmed.startsWith("v") ? trimmed : `v${trimmed}`;
}
