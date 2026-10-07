import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { DEFAULT_EXECUTOR_IMAGE } from "../topology";

const execFileAsync = promisify(execFile);

export async function buildExecutorImage(tag: string = DEFAULT_EXECUTOR_IMAGE): Promise<string> {
  await execFileAsync("docker", ["build", "-q", "-t", tag, import.meta.dirname], {
    timeout: 900_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  return tag;
}
