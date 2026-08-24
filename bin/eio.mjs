#!/usr/bin/env node

import { runCliEntrypoint } from "../dist/cli-entry.mjs";

await runCliEntrypoint({ commandName: "eio", deprecated: true });
