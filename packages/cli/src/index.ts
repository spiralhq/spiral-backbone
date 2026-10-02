#!/usr/bin/env tsx
import { Command } from "commander";
import { fetch_ as fetch } from "./commands/fetch/index";
import { org } from "./commands/org/index";
import { submit } from "./commands/submit";
import { verify } from "./commands/verify";

const program = new Command().name("spiral").description("Spiral protocol CLI").version("0.0.0");

program.addCommand(fetch);
program.addCommand(org);
program.addCommand(submit);
program.addCommand(verify);

program.parse();
