import { CommandIntakeService } from "../../src/coordination/command-intake-service.mjs";

export const agentCommandIntake = (store, now) => new CommandIntakeService({
  store,
  ...(now ? { now } : {}),
});
