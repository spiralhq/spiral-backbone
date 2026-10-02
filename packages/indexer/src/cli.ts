#!/usr/bin/env tsx
import { Command } from "commander";
import { backfillCommand } from "./commands/backfill";

const program = new Command()
  .name("spiral-indexer")
  .description("Rebuilds the Spiral relational catalog from on-chain accounts")
  .version("0.0.0");

program.addCommand(backfillCommand);

await program.parseAsync();
