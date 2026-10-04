resource "google_storage_bucket" "directus_backups" {
  provider = google.infra

  name     = "${google_project.infra.project_id}-directus-backups"
  project  = google_project.infra.project_id
  location = var.directus_backup_bucket_location

  storage_class               = "STANDARD"
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"
  force_destroy               = false

  # The backup job performs verified rotation and initially retains exactly two
  # complete backup sets. Disable object versioning and GCS soft-delete copies
  # so deleted rotations do not continue consuming storage unexpectedly.
  versioning {
    enabled = false
  }

  soft_delete_policy {
    retention_duration_seconds = 0
  }

  labels = {
    application = "directus"
    purpose     = "verified-backups"
    managed-by  = "terraform"
  }

  depends_on = [google_project_service.project_service]

  lifecycle {
    prevent_destroy = true
  }
}

resource "google_service_account" "directus_backup" {
  provider = google.infra

  project      = google_project.infra.project_id
  account_id   = "directus-backup"
  display_name = "Directus verified backup writer"
  description  = "Writes and rotates verified Directus database and uploads backups in the dedicated GCS bucket."

  depends_on = [google_project_service.project_service]
}

resource "google_storage_bucket_iam_member" "directus_backup_object_admin" {
  provider = google.infra

  bucket = google_storage_bucket.directus_backups.name
  role   = "roles/storage.objectAdmin"
  member = "serviceAccount:${google_service_account.directus_backup.email}"
}

# Match the service-account key pattern used by tf-k8s-cluster-infra. The JSON
# credential is returned base64-encoded by the provider and retained only in
# protected Terraform state until the reconciliation script installs it in the
# Kubernetes Secret consumed by the backup CronJob.
resource "google_service_account_key" "directus_backup" {
  provider = google.infra

  service_account_id = google_service_account.directus_backup.name
  private_key_type   = "TYPE_GOOGLE_CREDENTIALS_FILE"

  keepers = {
    rotation_version = var.directus_backup_service_account_key_version
  }

  # This ordering lets one targeted apply of this key create the complete
  # Google-only dependency chain without selecting any OCI resource.
  depends_on = [google_storage_bucket_iam_member.directus_backup_object_admin]

  lifecycle {
    create_before_destroy = true
  }
}

# Publish Terraform-generated values to the existing Vault KV-v2 mount. Argo
# owns the Kubernetes resources, and External Secrets continuously materializes
# the namespaced Secret without any runner-side kubectl access.
resource "vault_kv_secret_v2" "directus_backup_gcs" {
  mount = "secret"
  name  = "directus-backup-gcs"

  data_json = jsonencode({
    bucket               = google_storage_bucket.directus_backups.name
    service_account_json = base64decode(google_service_account_key.directus_backup.private_key)
  })

  lifecycle {
    prevent_destroy = true
  }
}

output "directus_backup_bucket" {
  description = "GCS bucket used for verified Directus backups."
  value       = google_storage_bucket.directus_backups.name
}

output "directus_backup_service_account" {
  description = "Least-scope service account granted object administration on the Directus backup bucket."
  value       = google_service_account.directus_backup.email
}

output "directus_backup_service_account_key_name" {
  description = "Inventory name of the Terraform-managed GCS backup service-account key."
  value       = google_service_account_key.directus_backup.name
}

output "directus_backup_service_account_key_b64" {
  description = "Base64-encoded Google credentials JSON used to reconcile the Kubernetes backup Secret."
  value       = google_service_account_key.directus_backup.private_key
  sensitive   = true
}
