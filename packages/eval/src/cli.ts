#!/usr/bin/env tsx
import { Command } from "commander";
import { h1Command } from "./h1/command";
import { h2Command } from "./h2/command";
import { h3Command } from "./h3/command";
import { h4Command } from "./h4/command";
import { reportCommand } from "./report/command";

const program = new Command()
  .name("spiral-eval")
  .description("Spiral evaluation harness (H1, H2, H3, H4, report)")
  .version("0.0.0");

program.addCommand(h1Command);
program.addCommand(h2Command);
program.addCommand(h3Command);
program.addCommand(h4Command);
program.addCommand(reportCommand);

await program.parseAsync();
