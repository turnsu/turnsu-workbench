import { spawn } from "node:child_process";
import electron from "electron";
import { prepareChromiumEnvironment } from "../electron/chromium-environment.mjs";
const env = { ...process.env };
prepareChromiumEnvironment(env);
delete env.ELECTRON_RUN_AS_NODE;
// Set the locale before Chromium initializes its C runtime; changing process.env
// from the main module is too late for native filename conversion.
const child = spawn(
  typeof electron === "string" ? electron : process.execPath,
  process.argv.slice(2),
  { stdio: "inherit", env },
);
child.on("error", (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
child.on("exit", (code, signal) => {
  process.exitCode = code ?? (signal ? 1 : 0);
});
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => child.kill(signal));
