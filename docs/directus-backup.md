# Application PostgreSQL and Directus uploads backup

The `directus-full-backup` CronJob creates portable PostgreSQL custom-format
dumps for the `directus`, `espocrm`, `openwebui`, and `suncoast_crm`
application databases, plus a compressed archive of Directus uploads. It
verifies every database and upload artifact before promoting a backup in
Google Cloud Storage.

Each database dump is transactionally consistent with its own exported
snapshot. The four databases are captured sequentially, so the backup is not a
single cross-database transaction. The backup does not contain PostgreSQL
global roles, tablespaces, host configuration, or non-Directus application
file storage. Application bootstrap must recreate roles and privileges before
restoring these owner-neutral, privilege-neutral dumps.

## Safety state

The CronJob is enabled with `spec.suspend: false`. The static backup settings
are stored in the GitOps-managed `directus-backup-config` ConfigMap. Terraform
writes the generated bucket name and service-account JSON to Vault, and the
GitOps-managed `directus-backup-gcs` ExternalSecret continuously materializes
those values as a namespaced Kubernetes Secret.

The job connects through the same Oracle VM SSH path used by
`vm-stats-service`. PostgreSQL is read only from the backup job. Verification
uses an isolated PostgreSQL 16.15 sidecar in the Job pod.

The Vault bootstrap copies only the three additional application database
passwords into `secret/directus-backup-databases`. A dedicated Kubernetes auth
role can read only that Vault path. The `directus-backup-vault` SecretStore and
`directus-backup-databases` ExternalSecret materialize exactly the three
password keys needed by the backup job; the job does not receive access to the
broader CRM or OpenWebUI source secrets.

## Schedule and retention

- Schedule: `0 2 * * *`
- Time zone: `America/New_York`
- Initial retention: two successfully verified runs
- Later retention: set `RETENTION_COUNT` to `1` only after a backup has been
  manually restored and approved

Retention rotation occurs only after all of these steps succeed:

1. `pg_dump` completes for all four application databases.
2. `pg_restore --list` reads every archive.
3. Each dump restores into a separate isolated verification database.
4. Every restored table row count matches its source database at the exact
   PostgreSQL snapshot used by that database's `pg_dump`.
5. The uploads archive extracts successfully and every file checksum matches.
6. Local artifact checksums pass.
7. Every GCS upload completes and its remote size matches the local artifact.
8. The new `latest.json` pointer is uploaded.

If an earlier step fails, the existing GCS backups are not deleted.

## Terraform-managed GCS setup

`terraform/directus-backup-storage.tf` creates these resources in the existing
`google_project.infra` project:

- A private Standard-class regional bucket named
  `<project-id>-directus-backups`.
- A dedicated `directus-backup` service account.
- Bucket-level `roles/storage.objectAdmin` access for that service account.

The bucket has uniform access, enforced public-access prevention, versioning
disabled, soft delete disabled, `force_destroy = false`, and Terraform
`prevent_destroy = true`. Backup rotation is therefore controlled by the
verified backup job without retaining billable deleted copies.

After Terraform applies, retrieve the exact values with:

```sh
terraform output -raw directus_backup_bucket
terraform output -raw directus_backup_service_account
```

Terraform creates and inventories a `TYPE_GOOGLE_CREDENTIALS_FILE` key using
the same pattern as `tf-k8s-cluster-infra`. The private JSON is base64-encoded
in the sensitive Terraform output
`directus_backup_service_account_key_b64`; as with all Terraform-managed
service-account keys, the credential is present in protected Terraform state.
The `directus_backup_service_account_key_version` variable controls deliberate
rotation, and `create_before_destroy` prevents Terraform from revoking the old
key before its replacement exists.

`vault_kv_secret_v2.directus_backup_gcs` writes the generated values to
`secret/data/directus-backup-gcs`. Terraform uses the existing sensitive
`VAULT_TOKEN` and `VAULT_ADDRESS` workspace variables. The Vault value and the
service-account private key remain sensitive Terraform inputs/state; they are
never committed to Git or printed by the deployment workflow.

Argo applies the ConfigMap and ExternalSecret from
`manifests/24-directus-backup.yaml`. External Secrets reads the Vault keys
`bucket` and `service_account_json`, creating `directus/directus-backup-gcs`
with keys `GCS_BUCKET` and `service-account.json`. The CronJob reads the bucket
as an environment variable and mounts the JSON credential as a file. No GitHub
runner, HCP agent, or operator needs Kubernetes credentials for reconciliation.

Run the complete reviewed Terraform plan so the Vault publication resource is
included; do not target only the service-account key. The existing OCI
lifecycle protections remain in force. Before enabling the CronJob:

1. Verify `directus-backup-config` exists and both backup ExternalSecrets
   report `Ready=True`.
2. Confirm the generated GCS Secret contains non-empty `GCS_BUCKET` and
   `service-account.json` keys without printing their values.
3. Confirm the database Secret contains exactly `ESPOCRM_DB_PASSWORD`,
   `OPENWEBUI_DB_PASSWORD`, and `SUNCOAST_CRM_DB_PASSWORD` without printing
   their values.
4. Confirm `GCS_PREFIX` and `RETENTION_COUNT` in the ConfigMap manifest.
5. Confirm bucket Object Versioning and soft-delete settings match the storage
   budget; retained deleted versions still consume storage.
6. Run one manually created Job and inspect its logs and GCS artifacts before
   relying on the schedule.

## Backup layout

```text
gs://BUCKET/directus-production/
  latest.json
  previous.json
  runs/YYYYMMDDTHHMMSSZ/
    directus.dump
    directus.restore-list
    source-table-counts.txt
    databases.tar.gz
    databases.json
    uploads.tar.gz
    uploads.sha256
    manifest.json
    SHA256SUMS
```

With `RETENTION_COUNT=2`, only the run referenced by `latest.json` and the prior
successful run are retained. With `RETENTION_COUNT=1`, only the newest run is
retained.

## Restore outline

Download one immutable run directory and verify it before restoring:

```sh
sha256sum -c SHA256SUMS
createdb directus_restore
pg_restore --exit-on-error --no-owner --no-privileges \
  --dbname=directus_restore directus.dump
mkdir uploads-restored
tar -xzf uploads.tar.gz -C uploads-restored
(cd uploads-restored && sha256sum -c ../uploads.sha256)
```

`directus.dump` remains at the run root for backward compatibility.
`databases.tar.gz` contains all four verified dumps and their per-database
restore lists, source/restored row counts, manifests, and checksums:

```text
databases/
  directus/directus.dump
  espocrm/espocrm.dump
  openwebui/openwebui.dump
  suncoast_crm/suncoast_crm.dump
  SHA256SUMS
```

Extract the archive, verify `databases/SHA256SUMS`, then restore the desired
database into an isolated database owned by the application bootstrap role.

Use PostgreSQL 16 or a newer supported target for restoration. Restore into an
isolated database first; do not use `--clean` against production during a test.
