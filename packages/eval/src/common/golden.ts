import { inventoryRecordSchema, type InventoryRecord } from "@spiral-backbone/protocol";
import { readJsonLines } from "./ndjson";

export async function readGolden(path: string): Promise<InventoryRecord[]> {
  const records = await readJsonLines(path, inventoryRecordSchema);
  if (records.length === 0) throw new Error(`${path}: golden inventory is empty`);
  const workIds = new Set<string>();
  const films = new Set<string>();
  for (const record of records) {
    if (workIds.has(record.work_id))
      throw new Error(`${path}: duplicate work_id ${record.work_id}`);
    if (films.has(record.film_pda))
      throw new Error(`${path}: duplicate film_pda ${record.film_pda}`);
    workIds.add(record.work_id);
    films.add(record.film_pda);
  }
  return records;
}
