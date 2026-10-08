import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile, truncate, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { resultRecordSchema, type ResultRecord } from "@spiral-backbone/protocol";
import type { z } from "zod";

export function toJsonLine(value: unknown): string {
  return JSON.stringify(value, (_key, v) => (typeof v === "bigint" ? v.toString() : v));
}

export async function appendJsonLine(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${toJsonLine(value)}\n`);
}

export async function appendResult(path: string, record: ResultRecord): Promise<ResultRecord> {
  const parsed = resultRecordSchema.parse(record);
  await appendJsonLine(path, parsed);
  return parsed;
}

export type TailHint = (path: string) => string;

const MOVE_BY_HAND: TailHint = (path) =>
  `move that line out of the file by hand (for example to ${path}.partial-<ts>)`;

export const RESUME_H2: TailHint = (path) =>
  `resume the run (eval:h2 run --resume <run_id>), which moves it to ${path}.partial-<ts>`;

export class TruncatedTailError extends Error {
  constructor(path: string, line: number, hint: TailHint = MOVE_BY_HAND) {
    super(
      `${path}:${line}: truncated final line (no trailing newline, not valid JSON) — an interrupted write; ${hint(path)}`,
    );
  }
}

const parses = (line: string) => {
  try {
    JSON.parse(line);
    return true;
  } catch {
    return false;
  }
};

export async function assertNoTruncatedTail(path: string, hint?: TailHint): Promise<void> {
  if (!existsSync(path)) return;
  const text = await readFile(path, "utf8");
  if (text === "" || text.endsWith("\n") || parses(text.slice(text.lastIndexOf("\n") + 1))) return;
  throw new TruncatedTailError(path, text.split("\n").length, hint);
}

export async function recoverTruncatedTail(
  path: string,
  log: (message: string) => void,
  stamp: () => string = () => new Date().toISOString().replace(/[-:.]/g, ""),
): Promise<string | null> {
  if (!existsSync(path)) return null;
  const text = await readFile(path, "utf8");
  if (text === "" || text.endsWith("\n")) return null;
  const start = text.lastIndexOf("\n") + 1;
  const tail = text.slice(start);
  if (parses(tail)) {
    await appendFile(path, "\n");
    log(`${path}: final line lacked its newline; terminated it`);
    return null;
  }
  const moved = `${path}.partial-${stamp()}`;
  await writeFile(moved, tail, { flag: "wx" });
  await truncate(path, Buffer.byteLength(text.slice(0, start)));
  log(`${path}: truncated final line (${Buffer.byteLength(tail)} bytes) moved to ${moved}`);
  return moved;
}

export async function readJsonLines<T>(
  path: string,
  schema: z.ZodType<T>,
  hint?: TailHint,
): Promise<T[]> {
  const text = await readFile(path, "utf8");
  const records: T[] = [];
  const lines = text.split("\n");
  lines.forEach((line, index) => {
    if (line.trim() === "") return;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch (error) {
      if (index === lines.length - 1) throw new TruncatedTailError(path, index + 1, hint);
      throw new Error(`${path}:${index + 1}: invalid JSON (${(error as Error).message})`);
    }
    const parsed = schema.safeParse(raw);
    if (!parsed.success) {
      const detail = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
      throw new Error(`${path}:${index + 1}: ${detail}`);
    }
    records.push(parsed.data);
  });
  return records;
}
