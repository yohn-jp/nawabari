#!/usr/bin/env node
import { runCli } from "./cli.js";

export * from "./working-set.js";
export { nawabariWorkingSetContract } from "./public-contract.js";

runCli(process.argv.slice(2)).then((exitCode) => {
  process.exitCode = exitCode;
});
