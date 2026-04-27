#!/bin/bash

# =============================================================================
# updateDashboardLimitCodes.sh
#
# Updates the SSM Parameter Store parameter /QuotaMonitor/DashboardLimitCodes
# with a comma-separated list of quota codes.
#
# The parameter is of type StringList and is used by the Quota Monitor
# dashboard to determine which EC2 quota codes to display.
#
# Preconditions:
#   - AWS CLI v2 installed and available on PATH
#   - Authenticated with a profile that has ssm:PutParameter permission
#     on the target parameter. For example:
#       export AWS_PROFILE=admin-quota-monitoring
#   - The quota-monitor stack is deployed in the target account/region
#
# Usage:
#   chmod +x scripts/updateDashboardLimitCodes.sh
#   ./scripts/updateDashboardLimitCodes.sh "L-88CF9481,L-A1B5A36F,L-DB2E81BA"
# =============================================================================

set -euo pipefail

PARAMETER_NAME="/QuotaMonitor/DashboardLimitCodes"

if [ $# -ne 1 ]; then
  echo "Usage: $0 <comma-separated-quota-codes>"
  echo "Example: $0 \"L-88CF9481,L-A1B5A36F,L-DB2E81BA\""
  exit 1
fi

QUOTA_CODES="$1"

echo "Updating parameter: $PARAMETER_NAME"
echo "New value: $QUOTA_CODES"

aws ssm put-parameter \
  --name "$PARAMETER_NAME" \
  --type "StringList" \
  --value "$QUOTA_CODES" \
  --overwrite

echo "Done"
