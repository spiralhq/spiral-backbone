import { createHash } from "node:crypto";
import { copyFile, open } from "node:fs/promises";

export function tamperOffset(seed: string, size: number): number {
  if (size < 4) throw new Error(`file too small to tamper in its middle half (${size} bytes)`);
  const start = Math.floor(size / 4);
  const span = Math.floor(size / 2);
  const n = createHash("sha256").update(seed).digest().readUIntBE(0, 6);
  return start + (n % span);
}

export async function writeTamperedCopy(
  sourcePath: string,
  destPath: string,
  offset: number,
): Promise<{ original: number; tampered: number }> {
  await copyFile(sourcePath, destPath);
  const handle = await open(destPath, "r+");
  try {
    const buffer = Buffer.alloc(1);
    await handle.read(buffer, 0, 1, offset);
    const original = buffer[0]!;
    buffer[0] = original ^ 0xff;
    await handle.write(buffer, 0, 1, offset);
    return { original, tampered: buffer[0]! };
  } finally {
    await handle.close();
  }
}
