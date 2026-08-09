#!/usr/bin/env node

import { runCli } from "../src/cli.js";

try {
  const exitCode = await runCli(process.argv.slice(2));
  process.exitCode = exitCode;
} catch (error) {
  const message = error instanceof Error
    ? process.env.LLMNAV_DEBUG
      ? error.stack ?? error.message
      : error.message
    : String(error);
  console.error(`llmnav: ${message}`);
  process.exitCode = Number.isInteger(error?.exitCode) ? error.exitCode : 1;
}
