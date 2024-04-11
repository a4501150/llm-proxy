#!/bin/bash
#
# Test Claude model availability on Vertex AI
# Usage: ./test-model-availability.sh [project_id]
#
# This script tests which Claude models are available in your GCP project
# across different regions using the Vertex AI rawPredict endpoint.
#

PROJECT_ID="${1:-spotify-claude-code-trial}"

echo "Testing Claude models on Vertex AI..."
echo "Project: $PROJECT_ID"
echo ""

# Get access token
TOKEN=$(gcloud auth print-access-token 2>/dev/null)
if [ -z "$TOKEN" ]; then
  echo "ERROR: Failed to get access token. Make sure you're logged in with 'gcloud auth login'"
  exit 1
fi

# Models to test
MODELS=(
  "claude-opus-4-5@20251101"
  "claude-sonnet-4-5@20251101"
  "claude-haiku-4-5@20251001"
  "claude-3-5-sonnet-v2@20241022"
  "claude-3-5-haiku@20241022"
  "claude-3-opus@20240229"
  "claude-3-sonnet@20240229"
  "claude-3-haiku@20240307"
)

# Regions to test
REGIONS=(
  "global"
  "us-central1"
  "us-east5"
  "europe-west1"
  "europe-west4"
  "asia-southeast1"
)

test_model() {
  local region=$1
  local model=$2
  local endpoint="https://${region}-aiplatform.googleapis.com/v1/projects/${PROJECT_ID}/locations/${region}/publishers/anthropic/models/${model}:rawPredict"

  response=$(curl -s -w "%{http_code}" -o /tmp/vertex_resp.txt -X POST "$endpoint" \
    -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/json" \
    -d '{"anthropic_version":"vertex-2023-10-16","max_tokens":10,"messages":[{"role":"user","content":"hi"}]}' \
    --connect-timeout 10 \
    --max-time 30)

  if [ "$response" = "200" ]; then
    echo "  ✅ AVAILABLE: $model"
  elif [ "$response" = "404" ]; then
    echo "  ❌ NOT_FOUND: $model"
  elif [ "$response" = "403" ]; then
    echo "  🔒 NO_ACCESS: $model (permission denied)"
  elif [ "$response" = "429" ]; then
    echo "  ⏳ RATE_LTD:  $model (rate limited, but exists)"
  else
    echo "  ⚠️  ERROR $response: $model"
  fi
}

# Run tests
for region in "${REGIONS[@]}"; do
  echo "=== Region: $region ==="
  for model in "${MODELS[@]}"; do
    test_model "$region" "$model"
  done
  echo ""
done

# Cleanup
rm -f /tmp/vertex_resp.txt

echo "Done!"
echo ""
echo "Note: 'global' region often returns 404 for direct API calls but may work"
echo "      through the Anthropic SDK which internally routes to a real region."
