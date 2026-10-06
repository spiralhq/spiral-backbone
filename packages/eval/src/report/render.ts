export function markdownTable(headers: string[], rows: string[][]): string {
  const escape = (cell: string) => cell.replaceAll("|", "\\|");
  const line = (cells: string[]) => `| ${cells.map(escape).join(" | ")} |`;
  return `${[line(headers), `|${headers.map(() => "---").join("|")}|`, ...rows.map(line)].join("\n")}\n`;
}

export function csv(headers: string[], rows: string[][]): string {
  const quote = (cell: string) => (/[",\n]/.test(cell) ? `"${cell.replaceAll('"', '""')}"` : cell);
  return `${[headers, ...rows].map((cells) => cells.map(quote).join(",")).join("\n")}\n`;
}
