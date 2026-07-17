#!/bin/bash
set -euo pipefail

database="${1:-}"
if [[ ! "$database" =~ ^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$ ]]; then
  exit 2
fi
username="$(cat /run/secrets/mongo_root_username)"
password="$(cat /run/secrets/mongo_root_password)"
port="${MONGO_PORT:-27017}"

exec mongosh --quiet \
  --host "127.0.0.1:${port}" \
  --username "$username" \
  --password "$password" \
  --authenticationDatabase admin \
  "$database" \
  --eval '
    const checks = [
      ["runs", "runId"],
      ["execution_events", "eventId"],
      ["execution_checkpoints", "checkpointId"],
      ["agent_turns", "turnId"],
      ["memory_deletion_tombstones", "tombstoneId"],
      ["audit_events", "auditEventId"]
    ];
    const result = {};
    const indexCounts = {};
    for (const [name, id] of checks) {
      const collection = db.getCollection(name);
      const count = collection.countDocuments({});
      const duplicates = collection.aggregate([
        { $match: { [id]: { $exists: true } } },
        { $group: { _id: `$${id}`, count: { $sum: 1 } } },
        { $match: { count: { $gt: 1 } } },
        { $limit: 1 }
      ]).toArray().length;
      result[name] = { readable: true, count, duplicateIds: duplicates };
      indexCounts[name] = collection.getIndexes().length;
    }
    result._migrationLedger = db.getCollection("product_schema_migrations")
      .find({}, { _id: 0, version: 1, checksum: 1, status: 1 })
      .sort({ version: 1 }).toArray();
    result._indexCounts = indexCounts;
    print(JSON.stringify(result));
    quit(Object.entries(result).filter(([name]) => !name.startsWith("_"))
      .every(([, item]) => item.duplicateIds === 0) ? 0 : 2);'
