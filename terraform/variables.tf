
variable "region" {
  default = "us-east1"
}

variable "project_name" {
  description = "The GCP project ID"
  type        = string
}

variable "gcp_org_id" {
  description = "The organization id to create the project under"
  type        = string
  nullable = false
}

variable billing_account {
    description = "The billing account to associate with the project"
    type        = string
    nullable = false
}

variable "GITHUB_ORG" {
  description = "GitHub organization for the cluster"
  type        = string
  default     = "suncoast-systems-k8s"
}

variable "GOOGLE_CREDENTIALS" {
  description = "Path to the GCP service account JSON key file"
  type        = string
  default     = "path/to/your/gcp-service-account.json"
}

variable "apis" {
  description = "The list of apis to enable"  
  type        = list(string)
  default     = [
    "iam.googleapis.com", 
    "cloudresourcemanager.googleapis.com", 
    "bigquery.googleapis.com",
    "bigquerystorage.googleapis.com",
    "cloudbilling.googleapis.com",
    "run.googleapis.com",
    "artifactregistry.googleapis.com",
    "containerregistry.googleapis.com",
    "cloudkms.googleapis.com",
    "compute.googleapis.com",
    "eventarc.googleapis.com",                   # ✅ Add this
    "pubsub.googleapis.com",                     # ✅ Recommended (used by Eventarc triggers)
    "secretmanager.googleapis.com",              # ✅ Required for your secret sync
    "logging.googleapis.com"                     # Optional, for better visibility
  ]
}

variable "GHCR_PAT" {
  description = "GitHub Container Registry Personal Access Token"
  type        = string
  default     = "your-ghcr-personal-access-token"
}

variable "api_key" {
  description = "API key for the GitHub profile service"
  type        = string
}