#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage:
  scripts/deploy-cloud-run.sh --salon-id <salon_id> [options]

Options:
  --tenant-file <path>                 Tenant ledger YAML. Defaults to tenants/<salon_id>.salon.yaml.
  --project-id <id>                    GCP project ID. Overrides tenant gcp_project_id.
  --region <region>                    Cloud Run region. Overrides tenant cloud_run_region.
  --service-name <name>                Cloud Run service name. Overrides tenant cloud_run_service.
  --image <image>                      Container image to deploy.
  --artifact-registry-repository <id>  Artifact Registry repository for computed image names.
  --image-name <name>                  Artifact Registry image name for computed image names.
  --image-tag <tag>                    Image tag for computed image names.
  --cloud-run-service-account <email>  Runtime service account.
  --database-secret-name <name>        Secret Manager secret for DATABASE_URL.
  --line-access-token-secret-name <name>
                                      Secret Manager secret for LINE_ACCESS_TOKEN.
  --scheduler-secret-name <name>       Secret Manager secret for SCHEDULER_SECRET.
  --liff-id <id>                       LIFF app ID.
  --line-channel-id <id>               LINE Login channel ID.
  --google-sheet-id <id>               Optional Google Sheet ID.
  --google-drive-folder-id <id>        Optional Google Drive folder ID.
  --gcs-bucket-name <name>             Optional GCS bucket name.
  --admin-line-id <ids>                Optional comma-separated admin LINE user IDs.
  --theme-color <color>                Optional theme color.
  --theme-color-light <color>          Optional light theme color.
  --theme-color-dark <color>           Optional dark theme color.
  --write-github-env <path>            Write resolved values to a GitHub Actions env file.
  --resolve-only                       Resolve and validate configuration without deploying.
  --dry-run                            Print the gcloud command instead of executing it.
  -h, --help                           Show this help.

Precedence:
  CLI options > environment variables > tenant YAML > safe defaults.
USAGE
}

die() {
  echo "error: $*" >&2
  exit 1
}

warn() {
  echo "warning: $*" >&2
}

first_non_empty() {
  local value
  for value in "$@"; do
    if [[ -n "${value}" ]]; then
      printf '%s' "${value}"
      return 0
    fi
  done
}

quote_cmd() {
  local arg
  printf '%q' "$1"
  shift
  for arg in "$@"; do
    printf ' %q' "${arg}"
  done
  printf '\n'
}

append_env_var() {
  local key="$1"
  local value="$2"

  [[ -n "${value}" ]] || return 0
  [[ "${value}" != *'|'* ]] || die "${key} contains unsupported '|' character"
  [[ "${value}" != *$'\n'* ]] || die "${key} contains unsupported newline"
  ENV_VARS+=("${key}=${value}")
}

write_github_env() {
  local path="$1"
  shift
  local entry key value

  for entry in "$@"; do
    key="${entry%%=*}"
    value="${entry#*=}"
    [[ "${value}" != *$'\n'* ]] || die "${key} contains unsupported newline"
    printf '%s=%s\n' "${key}" "${value}" >> "${path}"
  done
}

load_tenant_yaml() {
  local tenant_file="$1"

  python3 - "${tenant_file}" <<'PY'
import ast
import re
import shlex
import sys

path = sys.argv[1]
data = {}

def strip_inline_comment(value):
    in_single = False
    in_double = False
    for i, ch in enumerate(value):
        if ch == "'" and not in_double:
            in_single = not in_single
        elif ch == '"' and not in_single:
            in_double = not in_double
        elif ch == "#" and not in_single and not in_double:
            if i == 0 or value[i - 1].isspace():
                return value[:i].rstrip()
    return value.rstrip()

with open(path, "r", encoding="utf-8") as f:
    for raw in f:
        line = raw.rstrip("\n")
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        if line[0].isspace():
            continue
        match = re.match(r"^([A-Za-z_][A-Za-z0-9_]*):(.*)$", line)
        if not match:
            continue

        key, value = match.group(1), strip_inline_comment(match.group(2).strip())
        if value == "":
            continue
        if value in {"null", "Null", "NULL", "~"}:
            data[key] = ""
            continue
        if len(value) >= 2 and value[0] == value[-1] and value[0] in {"'", '"'}:
            try:
                data[key] = str(ast.literal_eval(value))
            except Exception:
                data[key] = value[1:-1]
        else:
            data[key] = value

for key, value in data.items():
    env_key = "TENANT_" + key.upper()
    print(f"{env_key}={shlex.quote(value)}")
PY
}

SALON_ID_ARG=""
TENANT_FILE=""
PROJECT_ID_ARG=""
REGION_ARG=""
SERVICE_NAME_ARG=""
IMAGE_ARG=""
ARTIFACT_REGISTRY_REPOSITORY_ARG=""
IMAGE_NAME_ARG=""
IMAGE_TAG_ARG=""
CLOUD_RUN_SERVICE_ACCOUNT_ARG=""
DATABASE_SECRET_NAME_ARG=""
LINE_ACCESS_TOKEN_SECRET_NAME_ARG=""
SCHEDULER_SECRET_NAME_ARG=""
LIFF_ID_ARG=""
LINE_CHANNEL_ID_ARG=""
GOOGLE_SHEET_ID_ARG=""
GOOGLE_DRIVE_FOLDER_ID_ARG=""
GCS_BUCKET_NAME_ARG=""
ADMIN_LINE_ID_ARG=""
THEME_COLOR_ARG=""
THEME_COLOR_LIGHT_ARG=""
THEME_COLOR_DARK_ARG=""
GITHUB_ENV_PATH=""
RESOLVE_ONLY=false
DRY_RUN=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --salon-id)
      SALON_ID_ARG="${2:-}"
      shift 2
      ;;
    --tenant-file)
      TENANT_FILE="${2:-}"
      shift 2
      ;;
    --project-id)
      PROJECT_ID_ARG="${2:-}"
      shift 2
      ;;
    --region)
      REGION_ARG="${2:-}"
      shift 2
      ;;
    --service-name)
      SERVICE_NAME_ARG="${2:-}"
      shift 2
      ;;
    --image)
      IMAGE_ARG="${2:-}"
      shift 2
      ;;
    --artifact-registry-repository)
      ARTIFACT_REGISTRY_REPOSITORY_ARG="${2:-}"
      shift 2
      ;;
    --image-name)
      IMAGE_NAME_ARG="${2:-}"
      shift 2
      ;;
    --image-tag)
      IMAGE_TAG_ARG="${2:-}"
      shift 2
      ;;
    --cloud-run-service-account)
      CLOUD_RUN_SERVICE_ACCOUNT_ARG="${2:-}"
      shift 2
      ;;
    --database-secret-name)
      DATABASE_SECRET_NAME_ARG="${2:-}"
      shift 2
      ;;
    --line-access-token-secret-name)
      LINE_ACCESS_TOKEN_SECRET_NAME_ARG="${2:-}"
      shift 2
      ;;
    --scheduler-secret-name)
      SCHEDULER_SECRET_NAME_ARG="${2:-}"
      shift 2
      ;;
    --liff-id)
      LIFF_ID_ARG="${2:-}"
      shift 2
      ;;
    --line-channel-id)
      LINE_CHANNEL_ID_ARG="${2:-}"
      shift 2
      ;;
    --google-sheet-id)
      GOOGLE_SHEET_ID_ARG="${2:-}"
      shift 2
      ;;
    --google-drive-folder-id)
      GOOGLE_DRIVE_FOLDER_ID_ARG="${2:-}"
      shift 2
      ;;
    --gcs-bucket-name)
      GCS_BUCKET_NAME_ARG="${2:-}"
      shift 2
      ;;
    --admin-line-id)
      ADMIN_LINE_ID_ARG="${2:-}"
      shift 2
      ;;
    --theme-color)
      THEME_COLOR_ARG="${2:-}"
      shift 2
      ;;
    --theme-color-light)
      THEME_COLOR_LIGHT_ARG="${2:-}"
      shift 2
      ;;
    --theme-color-dark)
      THEME_COLOR_DARK_ARG="${2:-}"
      shift 2
      ;;
    --write-github-env)
      GITHUB_ENV_PATH="${2:-}"
      shift 2
      ;;
    --resolve-only)
      RESOLVE_ONLY=true
      shift
      ;;
    --dry-run)
      DRY_RUN=true
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      die "unknown option: $1"
      ;;
  esac
done

SALON_ID="$(first_non_empty "${SALON_ID_ARG}" "${SALON_ID:-}")"
[[ -n "${SALON_ID}" ]] || die "--salon-id is required"
[[ "${SALON_ID}" =~ ^[a-z0-9]([a-z0-9-]*[a-z0-9])?$ ]] || die "salon_id must use lowercase letters, numbers, and hyphens: ${SALON_ID}"

TENANT_FILE="$(first_non_empty "${TENANT_FILE}" "tenants/${SALON_ID}.salon.yaml")"
[[ -f "${TENANT_FILE}" ]] || die "tenant file not found: ${TENANT_FILE}"

eval "$(load_tenant_yaml "${TENANT_FILE}")"

TENANT_SALON_ID="${TENANT_SALON_ID:-}"
[[ -z "${TENANT_SALON_ID}" || "${TENANT_SALON_ID}" == "${SALON_ID}" ]] || die "salon_id mismatch: input=${SALON_ID}, tenant=${TENANT_SALON_ID}"
TENANT_STATUS="${TENANT_STATUS:-}"

PROJECT_ID="$(first_non_empty "${PROJECT_ID_ARG}" "${PROJECT_ID:-}" "${GCP_PROJECT_ID:-}" "${TENANT_GCP_PROJECT_ID:-}")"
REGION="$(first_non_empty "${REGION_ARG}" "${REGION:-}" "${TENANT_CLOUD_RUN_REGION:-}" "asia-northeast1")"
SERVICE_NAME="$(first_non_empty "${SERVICE_NAME_ARG}" "${SERVICE_NAME:-}" "${TENANT_CLOUD_RUN_SERVICE:-}")"
ARTIFACT_REGISTRY_REPOSITORY="$(first_non_empty "${ARTIFACT_REGISTRY_REPOSITORY_ARG}" "${ARTIFACT_REGISTRY_REPOSITORY:-}" "reservation-system")"
IMAGE_NAME="$(first_non_empty "${IMAGE_NAME_ARG}" "${IMAGE_NAME:-}" "reservation-system-api")"
IMAGE_TAG="$(first_non_empty "${IMAGE_TAG_ARG}" "${IMAGE_TAG:-}" "${GITHUB_SHA:-}" "local")"
IMAGE="$(first_non_empty "${IMAGE_ARG}" "${IMAGE:-}" "${REGION}-docker.pkg.dev/${PROJECT_ID}/${ARTIFACT_REGISTRY_REPOSITORY}/${IMAGE_NAME}:${IMAGE_TAG}")"
CLOUD_RUN_SERVICE_ACCOUNT="$(first_non_empty "${CLOUD_RUN_SERVICE_ACCOUNT_ARG}" "${CLOUD_RUN_SERVICE_ACCOUNT:-}" "${TENANT_CLOUD_RUN_SERVICE_ACCOUNT:-}" "reservation-system-api@${PROJECT_ID}.iam.gserviceaccount.com")"

DATABASE_URL_SECRET_NAME="$(first_non_empty "${DATABASE_SECRET_NAME_ARG}" "${DATABASE_URL_SECRET_NAME:-}" "${TENANT_DATABASE_SECRET_NAME:-}" "salon-${SALON_ID}-database-url")"
LINE_ACCESS_TOKEN_SECRET_NAME="$(first_non_empty "${LINE_ACCESS_TOKEN_SECRET_NAME_ARG}" "${LINE_ACCESS_TOKEN_SECRET_NAME:-}" "${TENANT_LINE_ACCESS_TOKEN_SECRET_NAME:-}" "salon-${SALON_ID}-line-access-token")"
SCHEDULER_SECRET_SECRET_NAME="$(first_non_empty "${SCHEDULER_SECRET_NAME_ARG}" "${SCHEDULER_SECRET_SECRET_NAME:-}" "${TENANT_SCHEDULER_SECRET_NAME:-}" "salon-${SALON_ID}-scheduler-secret")"

LIFF_ID="$(first_non_empty "${LIFF_ID_ARG}" "${LIFF_ID:-}" "${TENANT_LINE_LIFF_ID:-}")"
LINE_CHANNEL_ID="$(first_non_empty "${LINE_CHANNEL_ID_ARG}" "${LINE_CHANNEL_ID:-}" "${TENANT_LINE_CHANNEL_ID:-}")"
GOOGLE_SHEET_ID="$(first_non_empty "${GOOGLE_SHEET_ID_ARG}" "${GOOGLE_SHEET_ID:-}" "${TENANT_GOOGLE_SHEET_ID:-}")"
GOOGLE_DRIVE_FOLDER_ID="$(first_non_empty "${GOOGLE_DRIVE_FOLDER_ID_ARG}" "${GOOGLE_DRIVE_FOLDER_ID:-}" "${TENANT_GOOGLE_DRIVE_FOLDER_ID:-}")"
GCS_BUCKET_NAME="$(first_non_empty "${GCS_BUCKET_NAME_ARG}" "${GCS_BUCKET_NAME:-}" "${TENANT_GCS_BUCKET_NAME:-}" "${PROJECT_ID}-images")"
ADMIN_LINE_ID="$(first_non_empty "${ADMIN_LINE_ID_ARG}" "${ADMIN_LINE_ID:-}")"
THEME_COLOR="$(first_non_empty "${THEME_COLOR_ARG}" "${THEME_COLOR:-}" "${TENANT_THEME_COLOR:-}")"
THEME_COLOR_LIGHT="$(first_non_empty "${THEME_COLOR_LIGHT_ARG}" "${THEME_COLOR_LIGHT:-}" "${TENANT_THEME_COLOR_LIGHT:-}")"
THEME_COLOR_DARK="$(first_non_empty "${THEME_COLOR_DARK_ARG}" "${THEME_COLOR_DARK:-}" "${TENANT_THEME_COLOR_DARK:-}")"

[[ -n "${PROJECT_ID}" ]] || die "project id is required"
[[ -n "${REGION}" ]] || die "region is required"
[[ -n "${SERVICE_NAME}" ]] || die "service name is required"
[[ -n "${IMAGE}" ]] || die "image is required"
[[ -n "${DATABASE_URL_SECRET_NAME}" ]] || die "DATABASE_URL secret name is required"
[[ -n "${LINE_ACCESS_TOKEN_SECRET_NAME}" ]] || die "LINE_ACCESS_TOKEN secret name is required"
[[ -n "${SCHEDULER_SECRET_SECRET_NAME}" ]] || die "SCHEDULER_SECRET secret name is required"

[[ -n "${LIFF_ID}" ]] || warn "LIFF_ID is empty"
[[ -n "${LINE_CHANNEL_ID}" ]] || warn "LINE_CHANNEL_ID is empty"
if [[ -n "${TENANT_STATUS}" && ! "${TENANT_STATUS}" =~ ^(setup|active)$ ]]; then
  warn "tenant status is ${TENANT_STATUS}; manual deploy is intended for setup or active tenants"
fi

if [[ -n "${GITHUB_ENV_PATH}" ]]; then
  write_github_env "${GITHUB_ENV_PATH}" \
    "SALON_ID=${SALON_ID}" \
    "TENANT_STATUS=${TENANT_STATUS}" \
    "PROJECT_ID=${PROJECT_ID}" \
    "GCP_PROJECT_ID=${PROJECT_ID}" \
    "REGION=${REGION}" \
    "SERVICE_NAME=${SERVICE_NAME}" \
    "IMAGE=${IMAGE}" \
    "ARTIFACT_REGISTRY_REPOSITORY=${ARTIFACT_REGISTRY_REPOSITORY}" \
    "IMAGE_NAME=${IMAGE_NAME}" \
    "IMAGE_TAG=${IMAGE_TAG}" \
    "CLOUD_RUN_SERVICE_ACCOUNT=${CLOUD_RUN_SERVICE_ACCOUNT}" \
    "DATABASE_URL_SECRET_NAME=${DATABASE_URL_SECRET_NAME}" \
    "LINE_ACCESS_TOKEN_SECRET_NAME=${LINE_ACCESS_TOKEN_SECRET_NAME}" \
    "SCHEDULER_SECRET_SECRET_NAME=${SCHEDULER_SECRET_SECRET_NAME}" \
    "LIFF_ID=${LIFF_ID}" \
    "LINE_CHANNEL_ID=${LINE_CHANNEL_ID}" \
    "GOOGLE_SHEET_ID=${GOOGLE_SHEET_ID}" \
    "GOOGLE_DRIVE_FOLDER_ID=${GOOGLE_DRIVE_FOLDER_ID}" \
    "GCS_BUCKET_NAME=${GCS_BUCKET_NAME}" \
    "ADMIN_LINE_ID=${ADMIN_LINE_ID}" \
    "THEME_COLOR=${THEME_COLOR}" \
    "THEME_COLOR_LIGHT=${THEME_COLOR_LIGHT}" \
    "THEME_COLOR_DARK=${THEME_COLOR_DARK}"
fi

echo "Resolved Cloud Run deploy target: salon_id=${SALON_ID}, status=${TENANT_STATUS:-unknown}, service=${SERVICE_NAME}, project=${PROJECT_ID}, region=${REGION}"
echo "Resolved image: ${IMAGE}"
echo "Resolved Secret Manager names: DATABASE_URL=${DATABASE_URL_SECRET_NAME}, LINE_ACCESS_TOKEN=${LINE_ACCESS_TOKEN_SECRET_NAME}, SCHEDULER_SECRET=${SCHEDULER_SECRET_SECRET_NAME}"

if [[ "${RESOLVE_ONLY}" == "true" ]]; then
  exit 0
fi

ENV_VARS=()
append_env_var "GCP_PROJECT_ID" "${PROJECT_ID}"
append_env_var "SERVICE_NAME" "${SERVICE_NAME}"
append_env_var "SALON_ID" "${SALON_ID}"
append_env_var "TZ" "Asia/Tokyo"
append_env_var "LIFF_ID" "${LIFF_ID}"
append_env_var "LINE_CHANNEL_ID" "${LINE_CHANNEL_ID}"
append_env_var "GOOGLE_SHEET_ID" "${GOOGLE_SHEET_ID}"
append_env_var "GOOGLE_DRIVE_FOLDER_ID" "${GOOGLE_DRIVE_FOLDER_ID}"
append_env_var "GCS_BUCKET_NAME" "${GCS_BUCKET_NAME}"
append_env_var "ADMIN_LINE_ID" "${ADMIN_LINE_ID}"
append_env_var "THEME_COLOR" "${THEME_COLOR}"
append_env_var "THEME_COLOR_LIGHT" "${THEME_COLOR_LIGHT}"
append_env_var "THEME_COLOR_DARK" "${THEME_COLOR_DARK}"

SET_ENV_VARS="^|^$(IFS='|'; echo "${ENV_VARS[*]}")"

GCLOUD_CMD=(
  gcloud run deploy "${SERVICE_NAME}"
  --project "${PROJECT_ID}"
  --image "${IMAGE}"
  --region "${REGION}"
  --platform managed
  --allow-unauthenticated
  --service-account "${CLOUD_RUN_SERVICE_ACCOUNT}"
  --set-env-vars "${SET_ENV_VARS}"
  --set-secrets "DATABASE_URL=${DATABASE_URL_SECRET_NAME}:latest"
  --set-secrets "LINE_ACCESS_TOKEN=${LINE_ACCESS_TOKEN_SECRET_NAME}:latest"
  --set-secrets "SCHEDULER_SECRET=${SCHEDULER_SECRET_SECRET_NAME}:latest"
)

if [[ "${DRY_RUN}" == "true" ]]; then
  echo "Dry run: Cloud Run deploy command"
  quote_cmd "${GCLOUD_CMD[@]}"
  exit 0
fi

"${GCLOUD_CMD[@]}"
