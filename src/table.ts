/**
 * Shared plain-text table rendering used by read commands (queue, nodes).
 * Renders a header row, a separator line, then the data rows, aligning
 * columns to their widest cell.
 */
export function formatTable(rows: string[][]): string {
  if (rows.length === 0) {
    return "";
  }
  const columnCount = Math.max(...rows.map((row) => row.length));
  const widths = Array.from({ length: columnCount }, (_, index) =>
    Math.max(...rows.map((row) => row[index]?.length ?? 0)),
  );
  const separatorWidth = Math.max(
    widths.reduce((sum, width) => sum + width, 0) + 2 * (columnCount - 1),
    1,
  );
  const lines = rows.map((row) =>
    row
      .map((cell, cellIndex) => cell.padEnd(widths[cellIndex] ?? cell.length))
      .join("  ")
      .replace(/\s+$/, ""),
  );
  return lines
    .flatMap((line, index) =>
      index === 1 ? ["-".repeat(separatorWidth), line] : [line],
    )
    .join("\n");
}

export function truncateCell(value: string, maxWidth: number): string {
  if (value.length <= maxWidth) {
    return value;
  }
  if (maxWidth <= 3) {
    return value.slice(0, maxWidth);
  }
  return `${value.slice(0, maxWidth - 3)}...`;
}
