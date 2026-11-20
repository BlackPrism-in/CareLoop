terraform {
  required_version = ">= 1.9"
  required_providers {
    google = { source = "hashicorp/google", version = "~> 7.0" }
  }
  # Configure per project: terraform init -backend-config="bucket=<state-bucket>"
  backend "gcs" { prefix = "careloop" }
}

provider "google" {
  project = var.project_id
  region  = var.region
}
