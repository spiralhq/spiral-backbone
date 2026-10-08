import { Command } from "commander";
import { generateReport } from "./run";

export const reportCommand = new Command("report")
  .description("Render H1-H4 tables and CSVs from the results NDJSON")
  .option("--results-dir <dir>", "directory with h1-h4 NDJSON", "results")
  .option("--out-dir <dir>", "where report.md and CSVs go", "results/report")
  .option("--plans-dir <dir>", "where frozen H2 plans live", "plans")
  .option("--run-h1 <id>", "H1 run to report instead of the latest")
  .option("--run-h2 <id>", "H2 run to report instead of the latest")
  .option("--run-h3 <id>", "H3 run to report instead of the latest")
  .option("--run-h4 <id>", "H4 run to report instead of the latest")
  .action(
    async (flags: {
      resultsDir: string;
      outDir: string;
      plansDir: string;
      runH1?: string;
      runH2?: string;
      runH3?: string;
      runH4?: string;
    }) => {
      try {
        const { markdownPath, csvPaths } = await generateReport({
          resultsDir: flags.resultsDir,
          outDir: flags.outDir,
          plansDir: flags.plansDir,
          runIds: { h1: flags.runH1, h2: flags.runH2, h3: flags.runH3, h4: flags.runH4 },
        });
        console.log(JSON.stringify({ markdown: markdownPath, csv: csvPaths }));
      } catch (error) {
        console.error(`Report failed: ${(error as Error).message}`);
        process.exitCode = 1;
      }
    },
  );
