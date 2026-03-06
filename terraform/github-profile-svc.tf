# 1. External data source fetches latest tag
data "external" "ghcr_tag" {
  program = ["bash", "-c", <<-EOT
    set -e
    TAG=$(curl -s \
      -H "Authorization: Bearer ${var.GHCR_PAT}" \
      https://api.github.com/users/${var.GITHUB_ORG}/packages/container/github-profile-service/versions \
      | jq -r '.[].metadata.container.tags[]' \
      | grep '^ts-' | sort -r | head -n1)
    jq -n --arg tag "$TAG" '{ tag: $tag }'
  EOT
  ]
}

# 2. Null resource tracks last synced tag and only runs when tag changes
resource "null_resource" "github_profile_tag_tracker" {
  triggers = {
    tag = data.external.ghcr_tag.result.tag
  }
}

locals {
  image_tag = null_resource.github_profile_tag_tracker.triggers.tag
}

resource "google_project_service" "project_service" {
  count = length(var.apis)

  disable_dependent_services = true
  project = google_project.infra.project_id
  service = var.apis[count.index]
}

resource "google_service_account" "default_compute" {
  account_id   = "default-compute-sa"
  display_name = "Default Compute Service Account for Cloud Run"
  project      = google_project.infra.project_id
}

data "google_compute_default_service_account" "default" {
  project = google_project.infra.project_id
  depends_on = [google_project_service.project_service, google_service_account.default_compute]
}

resource "google_project_iam_member" "registry_permissions" {
  project = google_project.infra.project_id
  role    = "roles/composer.environmentAndStorageObjectViewer"
  member  = "serviceAccount:service-${google_project.infra.number}@serverless-robot-prod.iam.gserviceaccount.com"
  depends_on = [data.google_compute_default_service_account.default]
}

resource "google_project_iam_member" "artifact_permissions" {
  project = google_project.infra.project_id
  role    = "roles/artifactregistry.reader"
  member  = "serviceAccount:service-${google_project.infra.number}@serverless-robot-prod.iam.gserviceaccount.com"
  depends_on = [data.google_compute_default_service_account.default]
}

resource "google_project_iam_member" "secret_manager_grant" {
  project = google_project.infra.project_id
  role    = "roles/secretmanager.secretAccessor"
  member  = "serviceAccount:${data.google_compute_default_service_account.default.email}"
}

resource "google_artifact_registry_repository" "thirdparty" {
  location      = var.region
  repository_id = "thirdparty"
  format        = "DOCKER"
  description   = "Third-party sidecars and base images"
  project            = google_project.infra.project_id
}


# --- DRY helpers ---
locals {
  app_image  = "${var.region}-docker.pkg.dev/${google_project.infra.project_id}/github-profile-service/github-profile-service:${local.image_tag}"
  
  app_env = [
    { name = "REQUIRE_API_KEY",             value = true },
    { name = "API_KEY",                     value = var.api_key },
    { name = "GROUP_PREFIX",                value = "github:" },
    { name = "GROUP_FORMAT",                value = "org:team" },
    { name = "INCLUDE_ROLE_SUFFIX",         value = "false" },
    { name = "INCLUDE_ORG_AS_GROUP",        value = "false" },
    { name = "ALLOWLIST_ORGS",              value = "dotcomrow" },
  ]

}

resource "google_cloud_run_v2_service" "github_profile_svc" {
  name                = "github-profile-service"
  location            = var.region
  project             = google_project.infra.project_id
  ingress             = "INGRESS_TRAFFIC_ALL"
  deletion_protection = false

  template {
    service_account = data.google_compute_default_service_account.default.email

    scaling {
      min_instance_count = 0
      max_instance_count = 1
    }

    # ---- App container ----
    containers {
      name  = "app"
      image = local.app_image

      dynamic "env" {
        for_each = { for i, e in local.app_env : i => e }
        content {
          name  = env.value.name
          value = env.value.value
        }
      }

      ports {
        container_port = 8080
      }

      resources {
        cpu_idle = true
      }
    }
  }

  depends_on = [
    google_project_iam_member.registry_permissions,
    google_project_iam_member.secret_manager_grant,
    null_resource.ghcr_to_gcp_image_sync,
    google_project_iam_member.cloud_run_secret_list
  ]
}

resource "google_cloud_run_v2_service_iam_member" "public_invoker" {
  name     = google_cloud_run_v2_service.github_profile_svc.name
  location = var.region
  project  = google_project.infra.project_id
  role     = "roles/run.invoker"
  member   = "allUsers"
}

resource "google_project_iam_member" "cloud_run_secret_list" {
  project = google_project.infra.project_id
  role    = "roles/secretmanager.viewer"
  member  = "serviceAccount:${data.google_compute_default_service_account.default.email}"
}

resource "google_artifact_registry_repository" "github_profile_repo" {
  location      = var.region
  repository_id = "github-profile-service"
  format        = "DOCKER"
  project       = google_project.infra.project_id
  description   = "Hosted repo for github-profile-service image"
  cleanup_policy_dry_run = var.artifact_registry_cleanup_dry_run

  cleanup_policies {
    id     = "delete-all-matching-images"
    action = "DELETE"
    condition {
      tag_state             = "ANY"
      package_name_prefixes = var.artifact_registry_package_prefixes
    }
  }

  cleanup_policies {
    id     = "keep-recent-images"
    action = "KEEP"
    most_recent_versions {
      keep_count            = var.artifact_registry_keep_recent_count
      package_name_prefixes = var.artifact_registry_package_prefixes
    }
  }

  depends_on = [google_project_service.project_service]
}

output "selected_image_tag" {
  value = local.image_tag
}

resource "null_resource" "image_sync_complete" {
  triggers = {
    tag = local.image_tag
  }
}

resource "null_resource" "ghcr_to_gcp_image_sync" {
  provisioner "local-exec" {
    interpreter = ["/bin/bash", "-c"]

    environment = {
      GHCR_USER               = var.GITHUB_ORG
      GHCR_PAT                = var.GHCR_PAT
      PROJECT_ID              = google_project.infra.project_id
      REGION                  = var.region
      IMAGE_NAME              = "github-profile-service"
      TAG                     = local.image_tag
    }

    command = <<-EOT
      set -euo pipefail

      run_low_prio() {
        if command -v ionice >/dev/null 2>&1 && command -v nice >/dev/null 2>&1; then
          ionice -c2 -n7 nice -n10 "$@"
        elif command -v nice >/dev/null 2>&1; then
          nice -n10 "$@"
        else
          "$@"
        fi
      }

      if ! command -v gcloud >/dev/null 2>&1; then
        echo "gcloud is required but not installed."
        echo "Install on this Proxmox host via proxmox-infra-ops Corekit:"
        echo "  ./corekit.sh install gcloud-cli"
        exit 1
      fi

      if ! command -v docker >/dev/null 2>&1; then
        echo "docker is required but not installed."
        exit 1
      fi

      export CLOUDSDK_CONFIG="$(mktemp -d)"
      export DOCKER_CONFIG="$(mktemp -d)"
      KEY_FILE="$(mktemp)"
      GHCR_IMAGE=""
      REPO_PATH=""
      cleanup() {
        docker logout ghcr.io >/dev/null 2>&1 || true
        docker logout "https://$REGION-docker.pkg.dev" >/dev/null 2>&1 || true
        if [ -n "$GHCR_IMAGE" ] && [ -n "$REPO_PATH" ] && [ -n "$${TAG:-}" ]; then
          docker image rm -f "$GHCR_IMAGE" "$REPO_PATH:$TAG" >/dev/null 2>&1 || true
        fi
        rm -rf "$CLOUDSDK_CONFIG" "$DOCKER_CONFIG" "$KEY_FILE"
      }
      trap cleanup EXIT

      : "$${GOOGLE_CREDENTIALS:?GOOGLE_CREDENTIALS is required}"
      printf "%s" "$GOOGLE_CREDENTIALS" > "$KEY_FILE"
      gcloud auth activate-service-account --key-file="$KEY_FILE"
      gcloud config set project "$PROJECT_ID"
      gcloud auth print-access-token | docker login -u oauth2accesstoken --password-stdin "https://$REGION-docker.pkg.dev"

      echo "$GHCR_PAT" | docker login ghcr.io -u "$GHCR_USER" --password-stdin

      if [ -z "$TAG" ] || [ -z "$IMAGE_NAME" ] || [ -z "$GHCR_USER" ]; then
        echo "One or more required variables are empty: TAG=$TAG, IMAGE_NAME=$IMAGE_NAME, GHCR_USER=$GHCR_USER"
        exit 1
      fi

      GHCR_IMAGE="ghcr.io/$GHCR_USER/$IMAGE_NAME:$TAG"
      REPO_PATH="$REGION-docker.pkg.dev/$PROJECT_ID/$IMAGE_NAME/$IMAGE_NAME"

      echo "Pulling from GHCR: $GHCR_IMAGE"
      run_low_prio docker pull "$GHCR_IMAGE"

      echo "Tagging and pushing image to Artifact Registry: $REPO_PATH:$TAG"
      docker tag "$GHCR_IMAGE" "$REPO_PATH:$TAG"
      run_low_prio docker push "$REPO_PATH:$TAG"

      echo "GHCR image pushed to Artifact Registry with tag $TAG"
    EOT
  }

  depends_on = [
    google_artifact_registry_repository.github_profile_repo,
    null_resource.github_profile_tag_tracker
  ]
  triggers = {
    tag = null_resource.github_profile_tag_tracker.triggers.tag
  }

  lifecycle {
    create_before_destroy = true
  }
}
