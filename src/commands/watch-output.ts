/**
 * Clack renders a spinner frame, two spaces, and up to three animated dots
 * around the supplied message. Its cleanup logic only measures the message,
 * so a message that fits by itself can still wrap and leave stale terminal
 * rows behind. Keep one additional column free to avoid pending-wrap behavior
 * at the terminal's right edge.
 */
const SPINNER_DECORATION_WIDTH = 7;

export function fitWatchSpinnerMessage(
  message: string,
  columns: number = process.stdout.columns ?? 80,
): string {
  const availableWidth = Math.max(
    0,
    Math.floor(columns) - SPINNER_DECORATION_WIDTH,
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
