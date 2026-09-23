import { Command } from "commander";
import { create } from "./create";
import { grant } from "./grant";
import { revoke } from "./revoke";

export const org = new Command()
  .name("org")
  .description("manage organizations and memberships")
  .addCommand(create)
  .addCommand(grant)
  .addCommand(revoke);
