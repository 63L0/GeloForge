#!/usr/bin/env node
/**
 * CLI entrypoint for validating an initialized project's Second Brain.
 */

import { parseArgs } from "node:util";
import { validateProject } from "../core/project-validator.mjs";

function printHelp() {
  console.log(`GeloForge Project Validator

Usage:
  node scripts/validate-project.mjs --project <path> [--json]
  node scripts/validate-project.mjs <path> [--json]
`);
}

function main() {
  let parsed;
  try {
    parsed = parseArgs({
      options: {
        project: { type: "string", short: "p" },
        json: { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
      },
      strict: true,
      allowPositionals: true,
    });
  } catch (err) {
    console.error(`ERROR: ${err.message}`);
    process.exit(1);
  }

  if (parsed.values.help) {
    printHelp();
    process.exit(0);
  }

  const target = parsed.values.project || parsed.positionals[0];
  if (!target) {
    printHelp();
    console.error("ERROR: Missing target project path (--project <path>).");
    process.exit(1);
  }

  const result = validateProject(target);
  if (parsed.values.json) {
    console.log(JSON.stringify(result, null, 2));
    if (!result.valid) {
      process.exit(1);
    }
    return;
  }

  console.log(`Project Validation: ${result.valid ? "PASS" : "FAIL"}`);
  console.log(`Compatibility     : ${result.compatibilityStatus}`);
  console.log(`Records Checked   : ${result.recordCount}`);
  console.log(`Markdown Checked  : ${result.checkedMarkdownFiles}`);

  if (result.warnings.length > 0) {
    console.log(`Warnings (${result.warnings.length}):`);
    for (const w of result.warnings) {
      console.log(`  - [WARN] ${w}`);
    }
  }
  if (result.errors.length > 0) {
    console.error(`Errors (${result.errors.length}):`);
    for (const e of result.errors) {
      console.error(`  - [ERR] ${e}`);
    }
    process.exit(1);
  }
}

main();
