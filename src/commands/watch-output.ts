/**
 * A live update must remain one column short of the terminal width so writing
 * it never triggers an automatic line wrap.
 */
const ACTIVE_PREFIX = "◒  ";
const LIVE_LINE_MARGIN_WIDTH = 1;

type WatchOutput = {
  columns?: number;
  write: (chunk: string) => unknown;
};

export type WatchSpinner = {
  start: (message: string) => void;
  stop: (message?: string) => void;
  message: (message: string) => void;
  error: (message: string) => void;
};

export function createWatchSpinner(
  output: WatchOutput = process.stdout,
): WatchSpinner {
  let active = false;
  let previousWidth = 0;
  let previousColumns = output.columns ?? 80;

  const writeLine = (line: string, newline = false): void => {
    const columns = output.columns ?? 80;
    const width = Bun.stringWidth(line);
    const resized = columns !== previousColumns;
    const padding = resized
      ? ""
      : " ".repeat(Math.max(0, previousWidth - width));
    const prefix = resized ? clearReflowedRows(previousWidth, columns) : "\r";
    output.write(`${prefix}${line}${padding}${newline ? "\n" : ""}`);
    previousWidth = newline ? 0 : width;
    previousColumns = columns;
  };

  const render = (message: string): void => {
    const fitted = fitWatchSpinnerMessage(message, output.columns ?? 80);
    writeLine(`${ACTIVE_PREFIX}${fitted}`);
  };

  const finish = (symbol: string, message: string): void => {
    if (!active) {
      return;
    }
    active = false;
    writeLine(`${symbol}  ${message}`, true);
  };

  return {
    start(message) {
      active = true;
      render(message);
    },
    stop(message = "") {
      finish("◇", message);
    },
    message(message) {
      if (active) {
        render(message);
      }
    },
    error(message) {
      finish("▲", message);
    },
  };
}

function clearReflowedRows(previousWidth: number, columns: number): string {
  const rowCount = Math.max(1, Math.ceil(previousWidth / Math.max(1, columns)));
  return `\r\u001B[2K${"\u001B[1A\r\u001B[2K".repeat(rowCount - 1)}`;
}

export function fitWatchSpinnerMessage(
  message: string,
  columns: number = process.stdout.columns ?? 80,
): string {
  const availableWidth = Math.max(
    0,
    Math.floor(columns) -
      Bun.stringWidth(ACTIVE_PREFIX) -
      LIVE_LINE_MARGIN_WIDTH,
  );
  if (Bun.stringWidth(message) <= availableWidth) {
    return message;
  }
  if (availableWidth === 0) {
    return "";
  }

  const ellipsis = "…";
  if (availableWidth === 1) {
    return ellipsis;
  }

  const contentWidth = availableWidth - Bun.stringWidth(ellipsis);
  const leadingWidth = Math.ceil(contentWidth / 2);
  const trailingWidth = contentWidth - leadingWidth;
  const leading = sliceToWidth(message, leadingWidth, false);
  const trailing = sliceToWidth(message, trailingWidth, true);
  return `${leading}${ellipsis}${trailing}`;
}

function sliceToWidth(
  message: string,
  maxWidth: number,
  fromEnd: boolean,
): string {
  for (let requestedWidth = maxWidth; requestedWidth > 0; requestedWidth--) {
    const sliced = fromEnd
      ? Bun.sliceAnsi(message, -requestedWidth)
      : Bun.sliceAnsi(message, 0, requestedWidth);
    // Bun preserves a wide character that straddles the requested boundary.
    if (Bun.stringWidth(sliced) <= maxWidth) {
      return sliced;
    }
  }
  return "";
}
