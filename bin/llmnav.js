#!/usr/bin/env node

import { runCli } from "../src/cli.js";
import { causeChain, LlmnavError } from "../src/errors.js";

try {
  const exitCode = await runCli(process.argv.slice(2));
  process.exitCode = exitCode;
} catch (error) {
  const debug = Boolean(process.env.LLMNAV_DEBUG);
  const labelled = error instanceof LlmnavError && error.code !== null ? `[${error.code}] ` : "";
  const message = error instanceof Error
    ? debug
      ? error.stack ?? error.message
      : error.message
    : String(error);
  console.error(`llmnav: ${labelled}${message}`);
  if (debug && error instanceof LlmnavError) {
    for (const link of causeChain(error).slice(1)) {
      const prefix = link.code === null ? "" : `[${link.code}] `;
      console.error(`  caused by: ${prefix}${link.message}`);
    }
  }
  process.exitCode = Number.isInteger(error?.exitCode) ? error.exitCode : 1;
}
