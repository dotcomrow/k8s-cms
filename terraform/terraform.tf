terraform {
  required_providers {
    google = {
      source = "hashicorp/google"
    }
    google-beta = {
      source = "hashicorp/google-beta"
    }
    oci = {
      source  = "oracle/oci"
      version = "~> 6.0"
    }
    tls = {
      source  = "hashicorp/tls"
      version = "~> 4.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.0"
    }
    external = {
      source  = "hashicorp/external"
      version = "~> 2.0"
    }
    null = {
      source  = "hashicorp/null"
      version = "~> 3.0"
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
