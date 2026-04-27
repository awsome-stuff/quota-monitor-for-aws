#!/bin/bash

# =============================================================================
# updateServiceMonitoring.sh
#
# Updates all services in the DynamoDB service table to Monitored: false,
# except for ec2 which is set to Monitored: true.
#
# NOTE: Each write triggers a DynamoDB Stream event on the quotaListManager
# Lambda. Services set to false will have their quotas removed from the
# quota table. Services set to true will have their quotas refreshed.
#
# Preconditions:
#   - AWS CLI v2 installed and available on PATH
#   - Authenticated with a profile that has read/write access to the target
#     DynamoDB table. For example:
#       export AWS_PROFILE=admin-quota-monitoring
#   - The quota-monitor spoke stack is deployed in the target account/region
#
# Usage:
#   chmod +x scripts/updateServiceMonitoring.sh
#   ./scripts/updateServiceMonitoring.sh
# =============================================================================

set -euo pipefail

TABLE="quota-monitor-sq-spoke-SQServiceTable0182B2D0-RF8FAHLZ0W7G"

echo "Scanning table: $TABLE"

aws dynamodb scan --table-name "$TABLE" --projection-expression "ServiceCode" --query "Items[].ServiceCode.S" --output text | tr '\t' '\n' | while read service; do
  if [ "$service" = "ec2" ]; then
    MONITORED=true
  else
    MONITORED=false
  fi
  aws dynamodb put-item --table-name "$TABLE" --item "{\"ServiceCode\":{\"S\":\"$service\"},\"Monitored\":{\"BOOL\":$MONITORED}}"
  echo "Set $service -> Monitored: $MONITORED"
done

echo "Done"
