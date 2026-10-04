# Directus PostgreSQL and uploads backup

The `directus-full-backup` CronJob creates a portable PostgreSQL custom-format
dump and a compressed archive of Directus uploads. It verifies both artifacts
before promoting a backup in Google Cloud Storage.

## Safety state

The CronJob is committed with `spec.suspend: true`. The backup ConfigMap is not
stored as a deployable manifest with a placeholder; the reconciliation script
renders it from the Terraform bucket output and the checked-in template. The
schedule cannot run until the CronJob is deliberately unsuspended.

The job connects through the same Oracle VM SSH path used by
`vm-stats-service`. PostgreSQL is read only from the backup job. Verification
uses an isolated PostgreSQL 16.15 sidecar in the Job pod.

## Schedule and retention

- Schedule: `0 2 * * *`
- Time zone: `America/New_York`
- Initial retention: two successfully verified runs
- Later retention: set `RETENTION_COUNT` to `1` only after a backup has been
  manually restored and approved

Retention rotation occurs only after all of these steps succeed:

1. `pg_dump` completes.
2. `pg_restore --list` reads the archive.
3. The dump restores into the isolated verification database.
4. Every restored table row count matches the source database.
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

After the targeted Terraform apply completes, reconcile the bucket reference
and key directly from HCP Terraform state into Kubernetes without committing
or printing the credential:

```sh
TFC_TOKEN="..." terraform/scripts/reconcile-directus-backup-gcs-secret.sh
```

The script validates the credential type and service-account email, renders
`terraform/templates/directus-backup-config.yaml.tftpl` with the
`directus_backup_bucket` output, applies the ConfigMap and
`directus/directus-backup-gcs`, verifies the live ConfigMap value, and removes
the temporary directory on exit. The credential exists only in a mode-0600
temporary file during reconciliation. Do not print or commit the sensitive
Terraform output. Before enabling the CronJob:

For the initial Google-only targeted run, target
`google_service_account_key.directus_backup`. Its dependency chain includes the
bucket, service account, bucket IAM grant, and required API, but no OCI
resource.

1. Run the reconciler and verify the generated `directus-backup-config`
   ConfigMap contains the `directus_backup_bucket` Terraform output.
2. Confirm `GCS_PREFIX` and `RETENTION_COUNT` in the ConfigMap template.
3. Confirm bucket Object Versioning and soft-delete settings match the storage
   budget; retained deleted versions still consume storage.
4. Change `spec.suspend` to `false` in `manifests/24-directus-backup.yaml`.
5. Run one manually created Job and inspect its logs and GCS artifacts before
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

Use PostgreSQL 16 or a newer supported target for restoration. Restore into an
isolated database first; do not use `--clean` against production during a test.
