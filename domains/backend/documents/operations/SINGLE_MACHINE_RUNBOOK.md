# PostgreSQL operations runbook

Status: local-development and restore-drill baseline. This is not a cloud deployment receipt.

PostgreSQL is the only Product database. The operational path has no dual-write, compatibility
Store or runtime fallback. Local development uses the digest-pinned PostgreSQL 16 image in
`docker-compose.yml`; production must inject a managed PostgreSQL DSN and complete migrations
before traffic.

## Required secrets and paths

- `WORKBENCH_POSTGRES_URL`: PostgreSQL DSN. Never print or commit it.
- `WORKBENCH_SECRETS_DIR/postgres-password`: local container password, owner-readable only.
- `WORKBENCH_OBJECT_STORE_ROOT`: governed object root paired with database backups.
- `WORKBENCH_BACKUP_KEY_FILE` or `WORKBENCH_BACKUP_KEY_BASE64`: exactly 32 bytes after Base64 decoding.

Use an explicitly named `_test` database for automated tests. Restore targets must end in
`_restore_test`; the paired object directory basename must also end in `_restore_test`.

## Local startup

```bash
cd domains/backend/code/workbench-server
npm run ops:local -- postgres-up
npm run ops:local -- migrate --confirm-write
npm run ops:local -- doctor
npm run ops:local -- serve
```

`scripts/start-workbench-server.sh` performs the same order: PostgreSQL readiness, migration,
Web build, then Product server. Set `WORKBENCH_MANAGED_POSTGRES=1` to skip the local container when
using a managed service. `/livez` may report process liveness during recovery; `/readyz` must not
succeed until the exact migration ledger and startup recovery are valid.

## Backup and isolated restore

```bash
npm run ops:local -- backup --output /secure/backups/2026-08-12

npm run ops:local -- restore \
  --source /secure/backups/2026-08-12 \
  --target-url 'postgresql://restore_user@127.0.0.1:5432/looloomi_restore_test' \
  --object-target /secure/restore/objects_restore_test \
  --confirm-restore
```

A backup set contains an encrypted custom-format `pg_dump`, an encrypted Object Store tarball and
an HMAC-authenticated manifest. Capture fails if the migration ledger is invalid. Restore verifies
component hashes and requires the restored database migration checksums and critical table counts
to equal the source snapshot. Never restore over the source database or a live Object Store.

The current local snapshot is not PITR or high availability. Production still needs provider-
managed continuous backups plus an independently controlled Object Store snapshot and retention
policy.

## Release candidate boundary

```bash
npm run ops:local -- stage-release --output /secure/release/manifest.json
npm run ops:local -- release --manifest /secure/release/manifest.json --confirm-release
```

The manifest binds Git HEAD, the complete dirty-tree digest, the pinned PostgreSQL image and exact
migration checksums with `fallback: false`. Activation refuses a changed candidate. This command
currently validates and starts the local composition; it does not deploy, switch production
traffic or prove SMTP/OAuth/Provider/Object Store readiness.

## Failure and rollback

- Migration or readiness failure: do not send traffic.
- Candidate drift: stage a new manifest; do not edit the old one.
- Restore failure: preserve diagnostic output but never point traffic at the restore target.
- Release failure: roll back database snapshot and application version as one maintenance-window
  operation. Do not restore an alternate database engine or enable runtime fallback.
- Credentials in logs or artifacts: rotate the affected secret and invalidate the candidate.
