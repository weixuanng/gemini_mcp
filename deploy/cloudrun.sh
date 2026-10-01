#!/usr/bin/env bash
# Deploys the Gemini MCP server to Google Cloud Run.
#
# Run it from the repository root in Google Cloud Shell (https://shell.cloud.google.com), or anywhere
# with the gcloud CLI installed and logged in:
#
#   ./deploy/cloudrun.sh
#
# Safe to re-run: it updates the existing service and keeps your stored keys.
#
# Optional environment variables:
#   PROJECT_ID           Google Cloud project to deploy into (default: the active gcloud project)
#   REGION               Cloud Run region (default: us-central1)
#   SERVICE              Cloud Run service name (default: gemini-mcp)
#   GEMINI_TIER          free | paid (asked interactively when unset)
#   GEMINI_USER_CONTEXT  A sentence about you that Gemini should always know
#   ENABLE_DEEP_RESEARCH true to add the (paid) Gemini Deep Research tools
#   UPDATE_GEMINI_KEY=1  Replace the stored Gemini API key
#   ROTATE_ACCESS_KEY=1  Generate a new access key (Claude will ask you to reconnect)
set -euo pipefail

SERVICE="${SERVICE:-gemini-mcp}"
REGION="${REGION:-us-central1}"
API_KEY_SECRET="gemini-api-key"
ACCESS_KEY_SECRET="gemini-mcp-access-key"

info() { printf '\033[36m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[33mWARNING:\033[0m %s\n' "$*" >&2; }
die() {
  printf '\033[31mERROR:\033[0m %s\n' "$*" >&2
  exit 1
}

command -v gcloud >/dev/null 2>&1 || die "gcloud CLI not found. Run this in Google Cloud Shell: https://shell.cloud.google.com"
[[ -f Dockerfile && -f package.json ]] || die "Run this script from the repository root (the folder that contains the Dockerfile)."

# --- Project -----------------------------------------------------------------------------------
PROJECT_ID="${PROJECT_ID:-$(gcloud config get-value project 2>/dev/null || true)}"
if [[ -z "$PROJECT_ID" || "$PROJECT_ID" == "(unset)" ]]; then
  echo "Your Google Cloud projects:"
  gcloud projects list --format='value(projectId)' --limit=20 || true
  read -rp "Project ID to deploy into: " PROJECT_ID
  [[ -n "$PROJECT_ID" ]] || die "No project ID given. Create one at https://console.cloud.google.com/projectcreate"
fi
gcloud config set project "$PROJECT_ID" >/dev/null 2>&1
PROJECT_NUMBER="$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')" ||
  die "Can't access project $PROJECT_ID. Check the ID and that you're logged in (gcloud auth login)."
info "Project: $PROJECT_ID ($PROJECT_NUMBER), region: $REGION, service: $SERVICE"

BILLING="$(gcloud billing projects describe "$PROJECT_ID" --format='value(billingEnabled)' --quiet 2>/dev/null || true)"
if [[ "$BILLING" == "False" ]]; then
  die "Billing isn't enabled for $PROJECT_ID. Cloud Run requires a billing account (personal use normally stays inside the free tier).
       Link one here, then re-run: https://console.cloud.google.com/billing/linkedaccount?project=$PROJECT_ID"
elif [[ "$BILLING" != "True" ]]; then
  warn "Couldn't confirm billing is enabled for $PROJECT_ID; continuing anyway."
fi

# --- APIs --------------------------------------------------------------------------------------
info "Enabling Cloud Run, Cloud Build, Artifact Registry and Secret Manager APIs (first run can take a minute)..."
gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com \
  secretmanager.googleapis.com --quiet

# --- Secrets -----------------------------------------------------------------------------------
secret_exists() { gcloud secrets describe "$1" >/dev/null 2>&1; }
store_secret() { # name value
  if secret_exists "$1"; then
    printf '%s' "$2" | gcloud secrets versions add "$1" --data-file=- >/dev/null
  else
    printf '%s' "$2" | gcloud secrets create "$1" --replication-policy=automatic --data-file=- >/dev/null
  fi
}

if secret_exists "$API_KEY_SECRET" && [[ "${UPDATE_GEMINI_KEY:-}" != "1" ]]; then
  info "Using the Gemini API key already in Secret Manager ($API_KEY_SECRET). Set UPDATE_GEMINI_KEY=1 to replace it."
else
  echo
  echo "Paste your Gemini API key (create one at https://aistudio.google.com/apikey). Input is hidden:"
  read -rs GEMINI_KEY
  echo
  GEMINI_KEY="$(printf '%s' "$GEMINI_KEY" | tr -d '[:space:]')"
  [[ -n "$GEMINI_KEY" ]] || die "No Gemini API key entered."
  store_secret "$API_KEY_SECRET" "$GEMINI_KEY"
  unset GEMINI_KEY
  info "Stored the Gemini API key in Secret Manager ($API_KEY_SECRET)."
fi

NEW_ACCESS_KEY=""
if secret_exists "$ACCESS_KEY_SECRET" && [[ "${ROTATE_ACCESS_KEY:-}" != "1" ]]; then
  info "Keeping the existing access key ($ACCESS_KEY_SECRET). Set ROTATE_ACCESS_KEY=1 to generate a new one."
else
  NEW_ACCESS_KEY="$(openssl rand -base64 33 | tr '+/' '-_' | tr -d '=\n')"
  store_secret "$ACCESS_KEY_SECRET" "$NEW_ACCESS_KEY"
  info "Generated a new access key and stored it in Secret Manager ($ACCESS_KEY_SECRET)."
fi

# --- Settings ----------------------------------------------------------------------------------
TIER="${GEMINI_TIER:-}"
if [[ -z "$TIER" ]]; then
  echo
  echo "Is billing enabled for your Gemini API key in Google AI Studio (the paid tier)?"
  echo "  Free tier: \$0, but Google may use your prompts to improve its products, and web search"
  echo "             runs on the older gemini-2.5-flash. Paid tier: newest models with search, private."
  read -rp "Paid tier? [y/N] " answer
  if [[ "$answer" =~ ^[Yy] ]]; then TIER="paid"; else TIER="free"; fi
fi
[[ "$TIER" == "free" || "$TIER" == "paid" ]] || die "GEMINI_TIER must be 'free' or 'paid'."

# Env vars are passed with a custom delimiter so values may contain commas.
ENV_VARS="GEMINI_TIER=$TIER"
if [[ -n "${GEMINI_USER_CONTEXT:-}" ]]; then
  ENV_VARS+="|GEMINI_USER_CONTEXT=${GEMINI_USER_CONTEXT//|/ }"
fi
if [[ -n "${ENABLE_DEEP_RESEARCH:-}" ]]; then
  ENV_VARS+="|ENABLE_DEEP_RESEARCH=$ENABLE_DEEP_RESEARCH"
fi

# --- Permissions -------------------------------------------------------------------------------
RUNTIME_SA="${PROJECT_NUMBER}-compute@developer.gserviceaccount.com"
info "Granting the service account access to the two secrets and permission to build from source..."
for secret in "$API_KEY_SECRET" "$ACCESS_KEY_SECRET"; do
  gcloud secrets add-iam-policy-binding "$secret" --member="serviceAccount:$RUNTIME_SA" \
    --role=roles/secretmanager.secretAccessor --quiet >/dev/null
done
gcloud projects add-iam-policy-binding "$PROJECT_ID" --member="serviceAccount:$RUNTIME_SA" \
  --role=roles/run.builder --condition=None --quiet >/dev/null ||
  warn "Couldn't grant roles/run.builder to $RUNTIME_SA; the build may fail if your project needs it."

# --- Deploy ------------------------------------------------------------------------------------
info "Building and deploying to Cloud Run (about 3-5 minutes)..."
gcloud run deploy "$SERVICE" \
  --source . \
  --region "$REGION" \
  --allow-unauthenticated \
  --set-secrets "GEMINI_API_KEY=${API_KEY_SECRET}:latest,MCP_ACCESS_KEY=${ACCESS_KEY_SECRET}:latest" \
  --update-env-vars "^|^${ENV_VARS}" \
  --memory 512Mi \
  --cpu 1 \
  --concurrency 20 \
  --min-instances 0 \
  --max-instances 2 \
  --timeout 300 \
  --quiet

URL="$(gcloud run services describe "$SERVICE" --region "$REGION" --format='value(status.url)')"
[[ -n "$URL" ]] || die "Deployment finished but the service URL couldn't be read."

if command -v curl >/dev/null 2>&1; then
  if curl -fsS --max-time 30 "$URL/healthz" >/dev/null; then
    info "Health check passed."
  else
    warn "The health check at $URL/healthz didn't respond yet. Give it a minute; check logs with:
         gcloud run services logs read $SERVICE --region $REGION --limit 50"
  fi
fi

cat <<EOF

$(printf '\033[32m')Done! Your Gemini MCP server is live.$(printf '\033[0m')

  Connector URL: ${URL}/mcp
EOF
if [[ -n "$NEW_ACCESS_KEY" ]]; then
  cat <<EOF
  Access key:    ${NEW_ACCESS_KEY}
                 (Save it in your password manager. You'll paste it once when connecting.)
EOF
else
  cat <<EOF
  Access key:    unchanged. Show it with:
                 gcloud secrets versions access latest --secret=${ACCESS_KEY_SECRET}
EOF
fi
cat <<EOF

Add it to Claude (web, desktop, mobile, and Claude Code on the web):
  1. Open https://claude.ai/customize/connectors, click "+", then "Add custom connector".
  2. Name: Gemini    URL: ${URL}/mcp    then Add.
  3. Click Connect. On the "Connect to Gemini MCP" page, paste the access key and click Approve.
  4. In a chat, enable it from the "+" menu > Connectors, then ask e.g.
     "Fact-check your last answer with Gemini."

Claude Code CLI (optional):
  claude mcp add --transport http gemini ${URL}/mcp --header "Authorization: Bearer <access key>"
EOF
