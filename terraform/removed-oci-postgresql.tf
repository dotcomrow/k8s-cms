# Keep these declarations through the first normal k8s-cms Terraform run after
# the ownership migration. They remove only source state records and never
# destroy the live OCI resources now owned by suncoast-external-infrastructure.

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
