#!/usr/bin/env node
import { GuardianRunner } from "../src/runner.mjs";

const runner = await GuardianRunner.create({ cwd: process.cwd() });
try {
  await runner.runInteractive();
} finally {
  await runner.dispose();
}
