terraform {
  required_providers {
    google = {
      source = "hashicorp/google"
    }
    google-beta = {
      source = "hashicorp/google-beta"
    }
  }
}

provider "google" {
  alias   = "infra"
  region  = var.region
  project = google_project.infra.project_id
}

provider "google-beta" {
  alias   = "infra"
  region  = var.region
  project = google_project.infra.project_id
}

provider "google" {
  region      = var.region
}

provider "google-beta" {
  region      = var.region
}