#!/bin/bash

# =============================================================================
# manageTestInstances.sh
#
# Launches or terminates t3.micro Linux instances for testing quota utilization.
# Instances are tagged with "QuotaMonitorTest" so they can be identified and
# torn down as a group.
#
# Preconditions:
#   - AWS CLI v2 installed and available on PATH
#   - Authenticated with a profile that has ec2:RunInstances, ec2:TerminateInstances,
#     ec2:DescribeInstances, ec2:CreateTags, and ec2:DescribeImages permissions.
#     For example:
#       export AWS_PROFILE=your-profile
#       export AWS_DEFAULT_REGION=eu-central-1
#   - A default VPC must exist in the target region (or instances will fail to launch)
#
# Usage:
#   Launch instances:
#     ./scripts/manageTestInstances.sh launch <count>
#     Example: ./scripts/manageTestInstances.sh launch 5
#
#   Terminate all test instances:
#     ./scripts/manageTestInstances.sh teardown
#
#   List running test instances:
#     ./scripts/manageTestInstances.sh status
# =============================================================================

set -euo pipefail

TAG_KEY="QuotaMonitorTest"
TAG_VALUE="true"
INSTANCE_TYPE="t3.micro"

usage() {
  echo "Usage:"
  echo "  $0 launch <count>   - Launch <count> t3.micro instances"
  echo "  $0 teardown         - Terminate all test instances"
  echo "  $0 status           - List running test instances"
  exit 1
}

get_latest_ami() {
  aws ec2 describe-images \
    --owners amazon \
    --filters "Name=name,Values=al2023-ami-2023*-x86_64" "Name=state,Values=available" \
    --query "Images | sort_by(@, &CreationDate) | [-1].ImageId" \
    --output text
}

launch_instances() {
  local count=$1
  echo "Finding latest Amazon Linux 2023 AMI..."
  local ami_id
  ami_id=$(get_latest_ami)
  echo "Using AMI: $ami_id"

  echo "Launching $count t3.micro instance(s)..."
  local instance_ids
  instance_ids=$(aws ec2 run-instances --image-id "$ami_id" --instance-type "$INSTANCE_TYPE" --count "$count" --tag-specifications "ResourceType=instance,Tags=[{Key=$TAG_KEY,Value=$TAG_VALUE}]" --query "Instances[].InstanceId" --output text)

  echo "Launched instances:"
  echo "$instance_ids" | tr '\t' '\n'
  echo ""
  echo "Run '$0 status' to check their state."
  echo "Run '$0 teardown' to terminate them."
}

teardown_instances() {
  echo "Finding test instances..."
  local instance_ids
  instance_ids=$(aws ec2 describe-instances \
    --filters "Name=tag:$TAG_KEY,Values=$TAG_VALUE" "Name=instance-state-name,Values=pending,running,stopping,stopped" \
    --query "Reservations[].Instances[].InstanceId" \
    --output text)

  if [ -z "$instance_ids" ]; then
    echo "No test instances found."
    return
  fi

  echo "Terminating instances: $instance_ids"
  aws ec2 terminate-instances --instance-ids $instance_ids --output table
  echo "Done. Instances are terminating."
}

show_status() {
  echo "Test instances:"
  aws ec2 describe-instances \
    --filters "Name=tag:$TAG_KEY,Values=$TAG_VALUE" \
    --query "Reservations[].Instances[].{InstanceId: InstanceId, State: State.Name, Type: InstanceType, LaunchTime: LaunchTime}" \
    --output table
}

# Main
if [ $# -lt 1 ]; then
  usage
fi

case "$1" in
  launch)
    if [ $# -ne 2 ] || ! [[ "$2" =~ ^[0-9]+$ ]] || [ "$2" -lt 1 ]; then
      echo "Error: launch requires a positive integer count"
      usage
    fi
    launch_instances "$2"
    ;;
  teardown)
    teardown_instances
    ;;
  status)
    show_status
    ;;
  *)
    usage
    ;;
esac
