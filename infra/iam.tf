# Separate least-privilege identities per service (MVP spec §19).
resource "google_service_account" "svc" {
  for_each     = toset(["web-api", "worker", "voice", "tasks-invoker"])
  account_id   = "careloop-${each.value}"
  display_name = "CareLoop ${each.value}"
}

locals {
  grants = {
    "web-api" = ["roles/datastore.user", "roles/cloudtasks.enqueuer", "roles/logging.logWriter"]
    "worker"  = ["roles/datastore.user", "roles/cloudtasks.enqueuer", "roles/aiplatform.user", "roles/logging.logWriter"]
    "voice"   = ["roles/datastore.user", "roles/aiplatform.user", "roles/cloudtasks.enqueuer", "roles/logging.logWriter"]
  }
  grant_pairs = flatten([for sa, roles in local.grants : [for r in roles : { sa = sa, role = r }]])
}

resource "google_project_iam_member" "grants" {
  for_each = { for g in local.grant_pairs : "${g.sa}:${g.role}" => g }
  project  = var.project_id
  role     = each.value.role
  member   = "serviceAccount:${google_service_account.svc[each.value.sa].email}"
}

resource "google_storage_bucket_iam_member" "sources_rw" {
  for_each = toset(["web-api", "worker"])
  bucket   = google_storage_bucket.sources.name
  role     = "roles/storage.objectUser"
  member   = "serviceAccount:${google_service_account.svc[each.value].email}"
}

# web-api must be able to mint OIDC tokens as the invoker when creating tasks.
resource "google_service_account_iam_member" "web_api_act_as_invoker" {
  for_each           = toset(["web-api", "worker", "voice"])
  service_account_id = google_service_account.svc["tasks-invoker"].name
  role               = "roles/iam.serviceAccountUser"
  member             = "serviceAccount:${google_service_account.svc[each.value].email}"
}

# Only the Cloud Tasks invoker identity may call the worker.
resource "google_cloud_run_v2_service_iam_member" "worker_invoker" {
  name     = google_cloud_run_v2_service.worker.name
  location = var.region
  role     = "roles/run.invoker"
  member   = "serviceAccount:${google_service_account.svc["tasks-invoker"].email}"
}
