export class CliError extends Error {}

export function handleCliError(error: unknown): never {
  if (error instanceof CliError) {
    console.error(`Error: ${error.message}`);
  } else if (error instanceof Error) {
    console.error(`Unexpected error: ${error.message}`);
  } else {
    console.error(`Unexpected error: ${String(error)}`);
  }
  process.exit(1);
}
