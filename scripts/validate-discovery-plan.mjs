#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const schemaPath = path.resolve("docs/architecture/DiscoveryPlanV1.schema.json");
const inputPath = process.argv[2];

if (!inputPath) {
  console.error("Usage: node scripts/validate-discovery-plan.mjs <json-file>");
  process.exit(2);
}

let Ajv;
try {
  ({ default: Ajv } = await import("ajv"));
} catch {
  console.error("Missing dependency: ajv. Install with: npm install --save-dev ajv");
  process.exit(2);
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (err) {
    console.error(`Failed to read/parse JSON: ${filePath}`);
    console.error(err.message);
    process.exit(2);
  }
}

const schema = readJson(schemaPath);
const payload = readJson(path.resolve(inputPath));

const ajv = new Ajv({ allErrors: true, strict: false });
const validate = ajv.compile(schema);
const valid = validate(payload);

if (valid) {
  console.log(`VALID: ${inputPath}`);
  process.exit(0);
}

console.error(`INVALID: ${inputPath}`);
for (const err of validate.errors ?? []) {
  const where = err.instancePath || "/";
  console.error(`- ${where}: ${err.message}`);
}
process.exit(1);
