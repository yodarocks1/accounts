#!/usr/bin/env node
import { LedgerError } from '@accounts/core';
import { CliError, run } from './cli.js';

try {
  console.log(run(process.argv.slice(2)));
} catch (error) {
  if (error instanceof CliError || error instanceof LedgerError) {
    console.error(`error: ${error.message}`);
    process.exit(1);
  }
  throw error;
}
