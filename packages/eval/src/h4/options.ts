import { z } from "zod";

const optionsSchema = z.object({
  golden: z.string().min(1),
  rpcUrl: z.url({ protocol: /^https?$/ }),
  databaseUrl: z.string().min(1),
  out: z.string().min(1),
  label: z.string().min(1),
});

export type H4CliOptions = z.infer<typeof optionsSchema>;

export function resolveH4Options(
  flags: Record<string, string | undefined>,
): { ok: true; options: H4CliOptions } | { ok: false; error: string } {
  const parsed = optionsSchema.safeParse({
    ...flags,
    rpcUrl: flags["rpcUrl"] ?? process.env["SPIRAL_RPC_URL"],
  });
  if (parsed.success) return { ok: true, options: parsed.data };
  const fields = parsed.error.issues.map((i) =>
    i.path[0] === "databaseUrl" ? "--database-url" : i.path.join("."),
  );
  return { ok: false, error: `invalid options (${fields.join(", ")})` };
}
