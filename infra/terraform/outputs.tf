output "service_url" {
  description = "Cloud Run's own URL for the service (always works, even with a custom domain)."
  value       = google_cloud_run_v2_service.whitepetal.uri
}

output "public_origin" {
  description = "The canonical origin given to the app as PUBLIC_ORIGIN. Register THIS one as the OAuth redirect origin."
  value       = local.public_origin
}

output "registry" {
  description = "Docker image prefix for every push: <registry>/whitepetal:<tag>."
  value       = "${var.region}-docker.pkg.dev/${var.project_id}/${google_artifact_registry_repository.whitepetal.repository_id}"
}

output "sql_connection_name" {
  description = "For the Cloud SQL proxy and for `gcloud sql connect`."
  value       = data.google_sql_database_instance.shared.connection_name
}

# The GitHub Actions repository variables (bootstrap.sh sets them with `gh`).
# None is a secret: the provider only mints a token for the named repository.
output "wif_provider" {
  description = "GCP_WIF_PROVIDER"
  value       = google_iam_workload_identity_pool_provider.github_whitepetal.name
}

output "deployer_sa" {
  description = "GCP_DEPLOYER_SA"
  value       = google_service_account.deployer.email
}

output "project_id" {
  value = var.project_id
}

output "region" {
  value = var.region
}

output "domain_dns_records" {
  description = "DNS records to create at the registrar for var.domain (empty until the mapping exists)."
  value       = var.domain == "" ? [] : google_cloud_run_domain_mapping.custom[0].status[0].resource_records
}
