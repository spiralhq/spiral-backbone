import { Command } from "commander";
import { generateReport } from "./run";

export const reportCommand = new Command("report")
  .description("Render H1-H4 tables and CSVs from the results NDJSON")
  .option("--results-dir <dir>", "directory with h1-h4 NDJSON", "results")
  .option("--out-dir <dir>", "where report.md and CSVs go", "results/report")
  .option("--plans-dir <dir>", "where frozen H2 plans live", "plans")
  .action(async (flags: { resultsDir: string; outDir: string; plansDir: string }) => {
    try {
      const { markdownPath, csvPaths } = await generateReport({
        resultsDir: flags.resultsDir,
        outDir: flags.outDir,
        plansDir: flags.plansDir,
      });
      console.log(JSON.stringify({ markdown: markdownPath, csv: csvPaths }));
    } catch (error) {
      console.error(`Report failed: ${(error as Error).message}`);
      process.exitCode = 1;
    }
  });
