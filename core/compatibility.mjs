/**
 * Lightweight version and compatibility checking for harness, template, schema, and profile versions.
 * Zero external dependencies.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEFAULT_COMPAT_PATH = path.join(__dirname, "compatibility.json");

export function loadCompatibilityConfig(compatPath = DEFAULT_COMPAT_PATH) {
  return JSON.parse(fs.readFileSync(compatPath, "utf8"));
}

export function parseSemver(version) {
  if (typeof version !== "string") {
    return null;
  }
  const match = version.trim().match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!match) {
    return null;
  }
  return {
    major: Number.parseInt(match[1], 10),
    minor: Number.parseInt(match[2], 10),
    patch: Number.parseInt(match[3], 10),
  };
}

export function checkRecordSchemaVersion(record, config = loadCompatibilityConfig()) {
  const version = record?.schema_version;
  if (typeof version !== "string" || !config.supported_schema_versions.includes(version)) {
    return {
      compatible: false,
      error: `Unsupported schema_version "${String(version)}" (supported: ${config.supported_schema_versions.join(", ")})`,
    };
  }
  return { compatible: true, error: null };
}

export function checkManifestCompatibility(manifest, config = loadCompatibilityConfig()) {
  const errors = [];
  const warnings = [];

  if (!manifest || typeof manifest !== "object") {
    return { compatible: false, status: "invalid", errors: ["Manifest must be an object."], warnings };
  }

  const schemaVer = manifest.schema_version;
  if (typeof schemaVer !== "string" || !config.supported_schema_versions.includes(schemaVer)) {
    errors.push(
      `Unsupported manifest schema_version "${String(schemaVer)}". Supported: ${config.supported_schema_versions.join(", ")}.`
    );
    return { compatible: false, status: "incompatible", errors, warnings };
  }

  if (schemaVer === "1.0") {
    warnings.push(
      `Project manifest uses legacy schema_version "1.0"; upgrade to "${config.default_schema_version}" when convenient (see docs/versioning-and-upgrades.md).`
    );
    return {
      compatible: true,
      status: "compatible_upgrade_available",
      errors,
      warnings,
    };
  }

  // Schema 1.1+ requires template_version and optional profile/profile_version consistency.
  const tplParsed = parseSemver(manifest.template_version);
  if (!tplParsed) {
    errors.push(
      `Manifest schema_version "${schemaVer}" requires semver template_version (got "${String(manifest.template_version)}").`
    );
  } else if (tplParsed.major !== config.supported_template_major) {
    errors.push(
      `Incompatible template_version major ${tplParsed.major} (harness supports major ${config.supported_template_major}).`
    );
  }

  if (manifest.profile !== undefined && manifest.profile !== null) {
    if (!Object.hasOwn(config.profiles, manifest.profile)) {
      errors.push(`Unknown project profile "${String(manifest.profile)}".`);
    } else {
      const profParsed = parseSemver(manifest.profile_version);
      if (!profParsed) {
        errors.push(
          `Profile "${manifest.profile}" requires semver profile_version (got "${String(manifest.profile_version)}").`
        );
      } else if (profParsed.major !== config.supported_profile_major) {
        errors.push(
          `Incompatible profile_version major ${profParsed.major} for "${manifest.profile}" (harness supports major ${config.supported_profile_major}).`
        );
      }
    }
  } else if (manifest.profile_version !== undefined && manifest.profile_version !== null) {
    errors.push("profile_version must be null when profile is null.");
  }

  return {
    compatible: errors.length === 0,
    status: errors.length === 0 ? "current" : "incompatible",
    errors,
    warnings,
  };
}

export function upgradeManifestFixture10To11(manifest10, config = loadCompatibilityConfig()) {
  if (!manifest10 || manifest10.schema_version !== "1.0") {
    throw new Error('Upgrade helper expects a schema_version "1.0" manifest.');
  }
  return {
    ...manifest10,
    schema_version: config.default_schema_version,
    harness_version: config.harness_version,
    template_version: config.template_version,
    profile: null,
    profile_version: null,
  };
}
