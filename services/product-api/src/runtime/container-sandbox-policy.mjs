export const DIGEST_PINNED_CONTAINER_IMAGE = /^(?:[A-Za-z0-9][A-Za-z0-9._/+:~-]*@)?sha256:[a-f0-9]{64}$/;
const SAFE_CONTAINER_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,191}$/;

export function buildContainerIsolationArguments({
  operation = "run",
  containerName,
  labels = [],
  limits,
  tmpfsBytes,
  fileSizeBytes,
  interactive = false,
  user = "65534:65534",
} = {}) {
  if (!["run", "create"].includes(operation)
    || !SAFE_CONTAINER_NAME.test(containerName || "")
    || !Array.isArray(labels)
    || labels.some((label) => typeof label !== "string" || !label.includes("="))
    || !positiveInteger(limits?.pids)
    || !positiveInteger(limits?.memoryBytes)
    || typeof limits?.cpus !== "number"
    || !Number.isFinite(limits.cpus)
    || limits.cpus <= 0
    || !positiveInteger(tmpfsBytes)
    || !positiveInteger(fileSizeBytes)
    || !/^\d+:\d+$/.test(user)) {
    throw new TypeError("container_sandbox_policy_invalid");
  }
  return [
    ...(operation === "run" ? ["run"] : ["container", "create"]),
    "--pull", "never",
    "--name", containerName,
    ...labels.flatMap((label) => ["--label", label]),
    ...(interactive ? ["--interactive"] : []),
    "--network", "none",
    "--read-only",
    "--cap-drop", "ALL",
    "--security-opt", "no-new-privileges",
    "--user", user,
    "--pids-limit", String(limits.pids),
    "--memory", String(limits.memoryBytes),
    "--cpus", String(limits.cpus),
    "--ulimit", "nofile=64:64",
    "--ulimit", "core=0:0",
    "--ulimit", `fsize=${fileSizeBytes}:${fileSizeBytes}`,
    "--tmpfs", `/tmp:rw,noexec,nosuid,nodev,size=${tmpfsBytes},mode=1777`,
  ];
}

function positiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}
