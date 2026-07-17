#!/bin/bash
set -euo pipefail

username="$(cat /run/secrets/mongo_root_username)"
password="$(cat /run/secrets/mongo_root_password)"
port="${MONGO_PORT:-27017}"

exec mongosh --quiet \
  --host "127.0.0.1:${port}" \
  --username "$username" \
  --password "$password" \
  --authenticationDatabase admin \
  --eval '
    const memberHost = process.env.MONGO_REPLICA_HOST || "127.0.0.1:27017";
    if (!/^127\.0\.0\.1:[0-9]+$/.test(memberHost)) quit(2);
    try {
      const status = rs.status();
      if (status.set !== "rs0") quit(2);
      quit(status.myState === 1 ? 0 : 1);
    } catch (error) {
      if (error.code === 94 || error.codeName === "NotYetInitialized") {
        const result = rs.initiate({
          _id: "rs0",
          members: [{ _id: 0, host: memberHost }]
        });
        quit(result.ok === 1 ? 1 : 2);
      }
      quit(2);
    }'
