variable "oci_tenancy_ocid" {
  description = "OCI tenancy OCID."
  type        = string

  validation {
    condition     = can(regex("^ocid1\\.tenancy\\..+", trimspace(var.oci_tenancy_ocid)))
    error_message = "oci_tenancy_ocid must be a valid tenancy OCID (ocid1.tenancy...)."
  }
}

variable "oci_user_ocid" {
  description = "OCI user OCID."
  type        = string

  validation {
    condition     = can(regex("^ocid1\\.user\\..+", trimspace(var.oci_user_ocid)))
    error_message = "oci_user_ocid must be a valid user OCID (ocid1.user...)."
  }
}

variable "oci_fingerprint" {
  description = "Fingerprint for the OCI API key."
  type        = string

  validation {
    condition     = can(regex("^([0-9a-fA-F]{2}:){15}[0-9a-fA-F]{2}$", trimspace(var.oci_fingerprint)))
    error_message = "oci_fingerprint must be in hex pair format, for example aa:bb:...:ff."
  }
}

variable "oci_private_key" {
  description = "OCI API private key PEM contents. Store as a sensitive Terraform variable."
  type        = string
  sensitive   = true

  validation {
    condition     = length(trimspace(var.oci_private_key)) > 0
    error_message = "oci_private_key must not be empty."
  }

  validation {
    condition     = can(regex("-----BEGIN (RSA )?PRIVATE KEY-----", replace(var.oci_private_key, "\\n", "\n")))
    error_message = "oci_private_key must contain a valid PEM private key block."
  }
}

variable "oci_region" {
  description = "OCI region, for example us-phoenix-1."
  type        = string

  validation {
    condition     = can(regex("^[a-z]{2}-[a-z]+-[0-9]+$", trimspace(var.oci_region)))
    error_message = "oci_region must look like us-phoenix-1 or us-ashburn-1."
  }
}

variable "oci_compartment_ocid" {
  description = "Compartment OCID where network and instance will be created."
  type        = string

  validation {
    condition     = can(regex("^ocid1\\.compartment\\..+", trimspace(var.oci_compartment_ocid)))
    error_message = "oci_compartment_ocid must be a valid compartment OCID (ocid1.compartment...)."
  }
}

variable "db_instance_name" {
  description = "Display name for the Oracle VM hosting PostgreSQL."
  type        = string
  default     = "directus-postgres"
}

variable "db_shape" {
  description = "Instance shape. E4 Flex supports low-cost burstable baseline."
  type        = string
  default     = "VM.Standard.E4.Flex"
}

variable "db_ocpus" {
  description = "OCPU count for the shape."
  type        = number
  default     = 1
}

variable "db_memory_gbs" {
  description = "RAM in GB for the shape. 2 GB is a practical minimum for small Postgres usage."
  type        = number
  default     = 2
}

variable "db_baseline_utilization" {
  description = "Burst baseline utilization for Flex instances."
  type        = string
  default     = "BASELINE_1_8"

  validation {
    condition = contains([
      "BASELINE_1_8",
      "BASELINE_1_2",
      "BASELINE_1_1",
    ], var.db_baseline_utilization)
    error_message = "db_baseline_utilization must be BASELINE_1_8, BASELINE_1_2, or BASELINE_1_1."
  }
}

variable "db_boot_volume_size_gb" {
  description = "Boot volume size in GB."
  type        = number
  default     = 500
}

variable "assign_public_ip" {
  description = "Assign a public IP to the VM."
  type        = bool
  default     = true
}

variable "db_allowed_cidrs" {
  description = "CIDRs allowed to connect to PostgreSQL on 5432."
  type        = list(string)
  default     = ["0.0.0.0/0"]

  validation {
    condition     = var.enable_db_ssh_tunnel || length(var.db_allowed_cidrs) > 0
    error_message = "db_allowed_cidrs must include at least one CIDR when enable_db_ssh_tunnel=false."
  }

  validation {
    condition     = alltrue([for cidr in var.db_allowed_cidrs : can(cidrhost(cidr, 0))])
    error_message = "db_allowed_cidrs entries must be valid CIDR blocks (for example 0.0.0.0/0 or 64.251.17.245/32)."
  }
}

variable "enable_db_ssh_tunnel" {
  description = "When true, lock PostgreSQL to localhost and require SSH local-port forwarding from Directus."
  type        = bool
  default     = true
}

variable "db_tunnel_user" {
  description = "SSH user for the Directus DB tunnel."
  type        = string
  default     = "directus_tunnel"
}

variable "db_tunnel_private_key_b64" {
  description = "Optional base64-encoded OpenSSH private key for the Directus DB tunnel. Set together with db_tunnel_public_key to keep tunnel credentials stable across Terraform workspace/state rebuilds."
  type        = string
  default     = null
  sensitive   = true

  validation {
    condition     = var.db_tunnel_private_key_b64 == null || trimspace(var.db_tunnel_private_key_b64) == "" || can(base64decode(var.db_tunnel_private_key_b64))
    error_message = "db_tunnel_private_key_b64 must be valid base64 when set."
  }
}

variable "db_tunnel_public_key" {
  description = "Optional OpenSSH public key for the Directus DB tunnel user. Required when db_tunnel_private_key_b64 is set."
  type        = string
  default     = null

  validation {
    condition     = var.db_tunnel_public_key == null || trimspace(var.db_tunnel_public_key) == "" || can(regex("^ssh-(ed25519|rsa)\\s+[A-Za-z0-9+/=]+(?:\\s+.*)?$", trimspace(var.db_tunnel_public_key)))
    error_message = "db_tunnel_public_key must be a valid OpenSSH public key line when set."
  }
}

variable "db_tunnel_local_port" {
  description = "Local forwarded DB port used inside the Directus pod."
  type        = number
  default     = 15432

  validation {
    condition     = var.db_tunnel_local_port >= 1025 && var.db_tunnel_local_port <= 65535
    error_message = "db_tunnel_local_port must be between 1025 and 65535."
  }
}

variable "ssh_allowed_cidrs" {
  description = "CIDRs allowed to SSH to the VM."
  type        = list(string)
  default     = ["0.0.0.0/0"]

  validation {
    condition     = alltrue([for cidr in var.ssh_allowed_cidrs : can(cidrhost(cidr, 0))])
    error_message = "ssh_allowed_cidrs entries must be valid CIDR blocks (for example 0.0.0.0/0 or 64.251.17.245/32)."
  }
}

variable "enable_directus_uploads_nfs" {
  description = "When true, cloud-init configures an NFS export on the OCI VM for Directus uploads/media files."
  type        = bool
  default     = true
}

variable "directus_uploads_nfs_allowed_cidrs" {
  description = "CIDRs allowed to mount the Directus uploads NFS export (NFS ports managed by Terraform)."
  type        = list(string)
  default     = ["0.0.0.0/0"]

  validation {
    condition     = !var.enable_directus_uploads_nfs || length(var.directus_uploads_nfs_allowed_cidrs) > 0
    error_message = "directus_uploads_nfs_allowed_cidrs must include at least one CIDR when enable_directus_uploads_nfs=true."
  }

  validation {
    condition     = alltrue([for cidr in var.directus_uploads_nfs_allowed_cidrs : can(cidrhost(cidr, 0))])
    error_message = "directus_uploads_nfs_allowed_cidrs entries must be valid CIDR blocks (for example 0.0.0.0/0 or 64.251.17.245/32)."
  }
}

variable "directus_uploads_nfs_enable_v3_compat" {
  description = "When true, enable NFSv3 compatibility on the VM and open rpcbind/mountd ports in OCI security rules."
  type        = bool
  default     = true
}

variable "directus_uploads_nfs_rpcbind_port" {
  description = "rpcbind port used for NFSv3 compatibility."
  type        = number
  default     = 111

  validation {
    condition     = var.directus_uploads_nfs_rpcbind_port >= 1 && var.directus_uploads_nfs_rpcbind_port <= 65535
    error_message = "directus_uploads_nfs_rpcbind_port must be between 1 and 65535."
  }
}

variable "directus_uploads_nfs_mountd_port" {
  description = "mountd port used for NFSv3 compatibility."
  type        = number
  default     = 20048

  validation {
    condition     = var.directus_uploads_nfs_mountd_port >= 1 && var.directus_uploads_nfs_mountd_port <= 65535
    error_message = "directus_uploads_nfs_mountd_port must be between 1 and 65535."
  }
}

variable "directus_uploads_export_path" {
  description = "Filesystem path on the OCI VM exported over NFS for Directus uploads/media."
  type        = string
  default     = "/srv/directus/uploads"
}

variable "directus_uploads_nfs_anon_uid" {
  description = "UID used for all NFS writes (all_squash) to keep ownership predictable."
  type        = number
  default     = 1000
}

variable "directus_uploads_nfs_anon_gid" {
  description = "GID used for all NFS writes (all_squash) to keep ownership predictable."
  type        = number
  default     = 1000
}

variable "ssh_authorized_keys" {
  description = "SSH public keys to inject into the instance metadata."
  type        = list(string)
  default     = []
}

variable "db_name" {
  description = "Directus database name."
  type        = string
  default     = "directus"
}

variable "directus_db_user" {
  description = "Directus database username."
  type        = string
  default     = "directus_app"
}

variable "directus_db_password" {
  description = "Directus database password. Keep constant between platform rebuilds."
  type        = string
  sensitive   = true

  validation {
    condition     = length(trimspace(var.directus_db_password)) >= 16
    error_message = "directus_db_password must be at least 16 characters."
  }
}

variable "vcn_cidr" {
  description = "VCN CIDR."
  type        = string
  default     = "10.42.0.0/16"
}

variable "subnet_cidr" {
  description = "Subnet CIDR."
  type        = string
  default     = "10.42.0.0/24"
}

variable "vcn_dns_label" {
  description = "DNS label for the VCN."
  type        = string
  default     = "directusdb"
}

variable "subnet_dns_label" {
  description = "DNS label for the subnet."
  type        = string
  default     = "dbsubnet"
}

variable "instance_hostname_label" {
  description = "Hostname label for the VM VNIC."
  type        = string
  default     = "directusdb"
}

variable "db_image_ocid" {
  description = "Optional explicit image OCID override."
  type        = string
  default     = null
}
