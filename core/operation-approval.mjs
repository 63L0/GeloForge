/** Owner authorization for bounded, explicitly scoped CLI operations. */
import fs from "node:fs";
import path from "node:path";
import { createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import { assertSafeWithinRoot, atomicWriteFile, hasSecretContent, isSameOrInside, walkNonSymlinkFiles } from "./path-safety.mjs";
import { readRegularFile, sha256 } from "./runtime-files.mjs";
import { scanAndAllocateRecordId } from "./project-locator.mjs";
import { validateAgainstSchema } from "./json-schema-lite.mjs";
import { parseYaml, serializeYaml } from "./yaml-subset.mjs";

function readKey(project, keyPath) {
  if (!keyPath) throw new Error("Supply the owner's key file explicitly.");
  const resolved = fs.realpathSync(path.resolve(keyPath));
  if (isSameOrInside(resolved, fs.realpathSync(project.projectDir))) {
    throw new Error("Keep the pinned owner key outside the project.");
  }
  const bytes = readRegularFile(resolved, 16 * 1024);
  if (!bytes) throw new Error("Owner key file is unavailable.");
  return bytes;
}

function operationPayload(project, record, digest) {
  return Buffer.from(JSON.stringify([
    "geloforge-operation-v1", project.manifest.project_id, project.manifest.owner,
    sha256(fs.realpathSync(project.projectDir)), record.id, record.decided_at,
    record.expires_at, record.boundary_category, record.target_records, digest,
  ]));
}

function checkApprovalSchema(project, record) {
  const schema = JSON.parse(fs.readFileSync(path.join(project.schemasDir, "approval-record.schema.json"), "utf8"));
  const result = validateAgainstSchema(record, schema);
  if (!result.valid) throw new Error(`Invalid approval record: ${result.errors.join("; ")}`);
}

export function signOperationApproval({ project, operation, privateKeyPath, expiresAt }) {
  const timestamp = new Date().toISOString();
  if (expiresAt != null && (!Number.isFinite(Date.parse(expiresAt)) || Date.parse(expiresAt) <= Date.parse(timestamp))) {
    throw new Error("Approval expiry must be a future ISO timestamp.");
  }
  const privateKey = createPrivateKey(readKey(project, privateKeyPath));
  if (privateKey.asymmetricKeyType !== "ed25519") throw new Error("Use an Ed25519 owner key.");
  const { projectDir, projectPaths, manifest } = project;
  const { id } = scanAndAllocateRecordId({
    projectDir, prefix: "APPR", searchDirs: [projectPaths.proposals_dir, projectPaths.decisions_dir],
  });
  const record = {
    schema_version: "1.1", id, title: operation.title, status: "approved",
    memory_layer: "L2_OPERATIONAL", authority_level: "A4", boundary_category: operation.category,
    requested_by: manifest.owner, requested_at: timestamp, decided_by: manifest.owner, decided_at: timestamp,
    expires_at: expiresAt ?? null, target_records: operation.targets,
    rationale: "Owner authorized this exact operation.",
    risk_assessment: operation.risk, conditions: [],
    operation_authorization: {
      digest: operation.digest,
      signature_base64: sign(null, operationPayload(project, {
        id, decided_at: timestamp, expires_at: expiresAt ?? null,
        boundary_category: operation.category, target_records: operation.targets,
      }, operation.digest), privateKey).toString("base64"),
    },
  };
  checkApprovalSchema(project, record);
  const relativePath = `${projectPaths.proposals_dir}/${id}-operation.yaml`;
  atomicWriteFile(assertSafeWithinRoot(projectDir, relativePath), serializeYaml(record), { allowOverwrite: false });
  return { approvalId: id, relativePath };
}

export function verifyOperationApproval({ project, operation, approvalId, publicKeyPath, remainingMs = 0 }) {
  if (typeof approvalId !== "string" || !/^APPR-\d{4}$/.test(approvalId)) {
    throw new Error("Supply a signed owner approval with --approval APPR-NNNN.");
  }
  const { projectDir, projectPaths } = project;
  const approvalDir = assertSafeWithinRoot(projectDir, projectPaths.proposals_dir);
  const filename = new RegExp(`^${approvalId}(?:-[^/]+)?\\.ya?ml$`, "i");
  const files = walkNonSymlinkFiles(projectDir, approvalDir, (file) => filename.test(path.basename(file)));
  if (files.length !== 1) throw new Error(`Expected one owner approval record for ${approvalId}.`);
  const raw = readRegularFile(files[0]);
  if (!raw || hasSecretContent(raw.toString())) throw new Error("Unsafe approval record.");
  const record = parseYaml(raw.toString(), approvalId);
  checkApprovalSchema(project, record);
  const authorization = record.operation_authorization;
  const now = Date.now();
  if (record.id !== approvalId || record.is_example || record.status !== "approved" ||
      record.decided_by !== project.manifest.owner || record.conditions.length !== 0 ||
      !Number.isFinite(Date.parse(record.decided_at)) || Date.parse(record.decided_at) > now ||
      (record.expires_at !== null && !(Date.parse(record.expires_at) > now + remainingMs)) ||
      record.boundary_category !== operation.category ||
      JSON.stringify(record.target_records) !== JSON.stringify(operation.targets) ||
      authorization?.digest !== operation.digest) {
    throw new Error(`Owner approval ${approvalId} does not authorize these inputs or has expired.`);
  }
  const keyBytes = readKey(project, publicKeyPath);
  if (!keyBytes.toString("utf8").trimStart().startsWith("-----BEGIN PUBLIC KEY-----")) {
    throw new Error("Pin the owner's public PEM, kept outside the project.");
  }
  const key = createPublicKey(keyBytes);
  if (key.asymmetricKeyType !== "ed25519" || !verify(null, operationPayload(project, record, operation.digest), key,
    Buffer.from(authorization.signature_base64, "base64"))) {
    throw new Error(`Owner signature for ${approvalId} did not match the pinned public key.`);
  }
  return record;
}
