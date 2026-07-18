#!/usr/bin/env node
import { LedgerError } from '@accounts/core';
import { CliError, run } from './cli.js';

try {
  console.log(run(process.argv.slice(2)));
} catch (error) {
  if (error instanceof LedgerError) {
    // The code is the stable contract (findings #3); the prose may change.
    console.error(`error [${error.code}]: ${error.message}`);
    process.exit(1);
  }
  if (error instanceof CliError) {
    console.error(`error: ${error.message}`);
    process.exit(1);
  }
  throw error;
}
