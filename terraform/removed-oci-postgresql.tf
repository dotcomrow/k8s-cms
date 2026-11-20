# Keep these declarations through the first normal k8s-cms Terraform run after
# the ownership migration. They remove only source state records and never
# destroy the live OCI resources now owned by suncoast-external-infrastructure.

# The provider configuration is temporary and exists only so Terraform can
# interpret the OCI addresses while removing them from this workspace's state.
variable "oci_tenancy_ocid" {
  type = string
}

variable "oci_user_ocid" {
  type = string
}

variable "oci_fingerprint" {
  type = string
}

variable "oci_private_key" {
  type      = string
  sensitive = true
}

variable "oci_region" {
  type = string
}

provider "oci" {
  tenancy_ocid = var.oci_tenancy_ocid
  user_ocid    = var.oci_user_ocid
  fingerprint  = var.oci_fingerprint
  private_key  = replace(var.oci_private_key, "\\n", "\n")
  region       = var.oci_region
}

removed {
  from = oci_core_vcn.directus_db

  lifecycle {
    destroy = false
  }
}

removed {
  from = oci_core_internet_gateway.directus_db

  lifecycle {
    destroy = false
  }
}

removed {
  from = oci_core_route_table.directus_db

  lifecycle {
    destroy = false
  }
}

removed {
  from = oci_core_security_list.directus_db

  lifecycle {
    destroy = false
  }
}

removed {
  from = oci_core_subnet.directus_db

  lifecycle {
    destroy = false
  }
}

removed {
  from = oci_core_instance.directus_db

  lifecycle {
    destroy = false
  }
}

removed {
  from = oci_core_public_ip.directus_db_reserved

  lifecycle {
    destroy = false
  }
}

removed {
  from = tls_private_key.db_tunnel

  lifecycle {
    destroy = false
  }
}
