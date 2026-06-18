#!/usr/bin/env node
import { createHmac, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const agentRuntimeRoot = resolve(__dirname, "..");
const projectRoot = resolve(agentRuntimeRoot, "..");
const envPath = resolve(projectRoot, ".env");

function loadEnvFile(path) {
  if (!existsSync(path)) return;
  const text = readFileSync(path, "utf8");
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    const [, key, rawValue] = match;
    if (process.env[key] != null) continue;
    process.env[key] = rawValue.replace(/^['"]|['"]$/g, "");
  }
}

function getConfig() {
  const region = String(process.env.ALIYUN_OSS_REGION || "cn-beijing").trim();
  const endpoint = String(process.env.ALIYUN_OSS_ENDPOINT || `oss-${region}.aliyuncs.com`)
    .replace(/^https?:\/\//, "")
    .replace(/\/+$/, "");
  return {
    bucket: String(process.env.ALIYUN_OSS_BUCKET || "").trim(),
    region,
    endpoint,
    accessKeyID: String(process.env.ALIYUN_OSS_ACCESS_KEY_ID || "").trim(),
    accessKeySecret: String(process.env.ALIYUN_OSS_ACCESS_KEY_SECRET || "").trim(),
    securityToken: String(process.env.ALIYUN_OSS_SECURITY_TOKEN || "").trim(),
    dashScopeAPIKey: String(process.env.DASHSCOPE_API_KEY || process.env.BAILIAN_API_KEY || "").trim(),
  };
}

function redact(value) {
  return String(value || "")
    .replace(/(OSSAccessKeyId|Signature|security-token)=([^&\s]+)/gi, "$1=[redacted]")
    .replace(/(AccessKeyId|AccessKeySecret|api[_-]?key|token|secret)\s*[:=]\s*[^&\s]+/gi, "$1=[redacted]")
    .slice(0, 1200);
}

function maskKeyID(value) {
  if (!value) return "missing";
  if (value.length <= 8) return "configured";
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

function requireConfig(config) {
  const missing = [];
  if (!config.bucket) missing.push("ALIYUN_OSS_BUCKET");
  if (!config.region) missing.push("ALIYUN_OSS_REGION");
  if (!config.endpoint) missing.push("ALIYUN_OSS_ENDPOINT");
  if (!config.accessKeyID) missing.push("ALIYUN_OSS_ACCESS_KEY_ID");
  if (!config.accessKeySecret) missing.push("ALIYUN_OSS_ACCESS_KEY_SECRET");
  if (missing.length) {
    throw new Error(`missing required OSS config: ${missing.join(", ")}`);
  }
}

function signOSSURL({ method, bucket, endpoint, objectKey, accessKeyID, accessKeySecret, securityToken, contentType = "", expiresAt }) {
  const objectPath = objectKey.split("/").map(encodeURIComponent).join("/");
  const securityQuery = securityToken ? `security-token=${encodeURIComponent(securityToken)}` : "";
  const canonicalResource = securityQuery
    ? `/${bucket}/${objectKey}?security-token=${encodeURIComponent(securityToken)}`
    : `/${bucket}/${objectKey}`;
  const stringToSign = `${method}\n\n${contentType}\n${expiresAt}\n${canonicalResource}`;
  const signature = createHmac("sha1", accessKeySecret).update(stringToSign).digest("base64");
  const params = [
    `OSSAccessKeyId=${encodeURIComponent(accessKeyID)}`,
    `Expires=${expiresAt}`,
    `Signature=${encodeURIComponent(signature)}`,
    securityQuery,
  ].filter(Boolean).join("&");
  return `https://${bucket}.${endpoint}/${objectPath}?${params}`;
}

async function main() {
  loadEnvFile(envPath);
  const config = getConfig();
  requireConfig(config);

  const objectKey = `agent-asr/config-check/${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID()}.txt`;
  const expiresAt = Math.floor(Date.now() / 1000) + 600;
  const body = `cloud-asr-oss-config-check ${new Date().toISOString()}\n`;
  const contentType = "text/plain";

  console.log("cloud_asr_oss_check=start");
  console.log(`env_path=${envPath}`);
  console.log(`bucket=${config.bucket}`);
  console.log(`region=${config.region}`);
  console.log(`endpoint=${config.endpoint}`);
  console.log(`access_key_id=${maskKeyID(config.accessKeyID)}`);
  console.log(`dashscope_api_key=${config.dashScopeAPIKey ? "configured" : "missing"}`);
  console.log(`probe_object=${objectKey}`);

  const putURL = signOSSURL({
    method: "PUT",
    bucket: config.bucket,
    endpoint: config.endpoint,
    objectKey,
    accessKeyID: config.accessKeyID,
    accessKeySecret: config.accessKeySecret,
    securityToken: config.securityToken,
    contentType,
    expiresAt,
  });

  const putResponse = await fetch(putURL, {
    method: "PUT",
    headers: { "Content-Type": contentType },
    body,
  });
  if (!putResponse.ok) {
    const preview = await putResponse.text().catch(() => "");
    throw new Error(`oss_put_failed status=${putResponse.status} body=${redact(preview)}`);
  }
  console.log("oss_put=pass");

  const getURL = signOSSURL({
    method: "GET",
    bucket: config.bucket,
    endpoint: config.endpoint,
    objectKey,
    accessKeyID: config.accessKeyID,
    accessKeySecret: config.accessKeySecret,
    securityToken: config.securityToken,
    expiresAt,
  });

  const getResponse = await fetch(getURL);
  if (!getResponse.ok) {
    const preview = await getResponse.text().catch(() => "");
    throw new Error(`oss_get_failed status=${getResponse.status} body=${redact(preview)}`);
  }
  const downloaded = await getResponse.text();
  if (downloaded !== body) {
    throw new Error("oss_get_mismatch: downloaded probe body differs from uploaded body");
  }

  console.log("oss_get=pass");
  console.log("cleanup=not_deleted_minimal_policy_put_get_only");
  console.log("cloud_asr_oss_check=pass");
}

main().catch((error) => {
  console.error(`cloud_asr_oss_check=fail ${redact(error?.message || error)}`);
  process.exitCode = 1;
});
