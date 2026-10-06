import { appendFile, mkdir, readFile } from "node:fs/promises";
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

export async function readJsonLines<T>(path: string, schema: z.ZodType<T>): Promise<T[]> {
  const text = await readFile(path, "utf8");
  const records: T[] = [];
  text.split("\n").forEach((line, index) => {
    if (line.trim() === "") return;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch (error) {
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
