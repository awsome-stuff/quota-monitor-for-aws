# Quota Dashboard for AWS — Deployment & Architecture Guide

This repository is a customized fork of the [Quota Monitor for AWS](https://docs.aws.amazon.com/solutions/latest/quota-monitor-for-aws/solution-overview.html) solution published by AWS Solutions Library. The original solution monitors AWS service quotas across accounts and sends notifications when usage approaches thresholds.

Our modifications add:

- An **Athena + Grafana** integration that enables SQL-based querying and visualization of quota usage data stored in DynamoDB.
- Configurable **OK notification filtering** via `OKNotificationLimitCodes` to control event volume.

---

## Table of Contents

1. [Getting Started — Single-Account Deployment](#getting-started--single-account-deployment)
2. [Architecture Overview](#architecture-overview)
3. [Data Flow](#data-flow)
4. [Athena + Grafana Integration](#athena--grafana-integration)
5. [Grafana Setup Guide](#grafana-setup-guide)
6. [Operational Notes](#operational-notes)

---

## Getting Started — Single-Account Deployment

This guide walks through deploying the solution in a single AWS account (no AWS Organizations). We use the **hub-no-ou** template for the monitoring account and the **sq-spoke** template in the same account.

### Prerequisites

- Node.js v22+ and npm 11+
- AWS CLI configured with appropriate credentials
- AWS CDK bootstrapped in your target account/region
- **AWS IAM Identity Center (SSO) enabled** in the account — required for Grafana authentication
- Target region must support Amazon Managed Grafana (e.g., `eu-central-1`, `eu-west-1`, `eu-west-2`, `us-east-1`)

### Step 1: Clone and install dependencies

```bash
git clone <this-repo-url>
cd quota-monitor-for-aws
npm ci
```

### Step 2: Build all assets

```bash
npm run build:all
```

### Step 3: Bootstrap CDK (if not done already)

```bash
cd source/resources
npm ci
npm run cdk -- bootstrap --profile <PROFILE_NAME>
```

### Step 4: Deploy the Hub stack

Deploy the hub-no-ou stack:

```bash
npm run cdk -- deploy quota-monitor-hub-no-ou --profile <PROFILE_NAME>
```

**CDK context flags:**

| Flag | Default | Description |
|------|---------|-------------|
| `ENABLE_GRAFANA` | `true` | Deploys Managed Grafana workspace, Athena workgroup, DynamoDB connector. Set to `false` to skip Grafana resources. |

### Step 5: Deploy the Spoke stack (same account)

After the hub is deployed, note the **EventBus ARN** from the stack outputs, then deploy the spoke:

```bash
npm run cdk -- deploy quota-monitor-sq-spoke \
  --parameters EventBusArn=<EVENT_BUS_ARN_FROM_HUB_OUTPUT> \
  --profile <PROFILE_NAME>
```

The only required parameter is `EventBusArn`. All others have sensible defaults.

### Step 6: Verify data is flowing

After one polling cycle (default: 30 minutes), check the DynamoDB summary table:

```bash
aws dynamodb scan \
  --table-name $(aws cloudformation describe-stacks \
    --stack-name quota-monitor-hub-no-ou \
    --query "Stacks[0].Outputs[?OutputKey=='QMTable'].OutputValue" \
    --output text 2>/dev/null || echo "CHECK_TABLE_NAME_IN_CONSOLE") \
  --max-items 5 \
  --profile <PROFILE_NAME>
```

### Stack Outputs

After deployment, the hub stack outputs:

| Output | Description |
|--------|-------------|
| `EventBus` | EventBridge bus ARN (needed for spoke deployment) |
| `GrafanaWorkspaceUrl` | Grafana dashboard URL (if ENABLE_GRAFANA=true) |
| `AthenaWorkgroup` | Athena workgroup name |
| `AthenaCatalog` | Athena data catalog name |

---

## Configuring Monitored Services

After deploying the spoke stack, the Service Table (DynamoDB) is populated with all discovered AWS services — all set to `Monitored: true` by default. For our use case, we only monitor **EC2** quotas. All other services must be disabled.

The script `scripts/updateServiceMonitoring.sh` handles this: it sets every service to `Monitored: false` except `ec2`.

```bash
chmod +x scripts/updateServiceMonitoring.sh
./scripts/updateServiceMonitoring.sh
```

> **Note:** Before running, update the `TABLE` variable in the script to match your actual Service Table name (visible in the CloudFormation outputs or the DynamoDB console). Each write triggers a DynamoDB Stream event that causes the QuotaListManager Lambda to refresh the quota list accordingly — services set to `false` have their quotas removed, `ec2` set to `true` will have its quotas populated. After running the script, look into the Quotas Table and check only EC2 quotas are present.

---

## Architecture Overview

The solution follows a **hub-spoke** model:

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         SPOKE ACCOUNT(S)                                │
│                                                                         │
│  ┌──────────────┐    ┌───────────────────┐    ┌─────────────────────┐   │
│  │ Service Table│◄───│ QuotaListManager  │    │ Spoke EventBridge   │   │
│  │ Quota Table  │    │ (custom resource) │    │ Bus                 │   │
│  └──────┬───────┘    └───────────────────┘    └──────────┬──────────┘   │
│         │                                                ▲              │
│         ▼                                                │              │
│  ┌──────────────┐         CloudWatch                     │              │
│  │  cwPoller    │────────(GetMetricData)─────────────────┘              │
│  │  Lambda      │         AWS/Usage namespace                           │
│  └──────────────┘                                                       │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                          EventBridge forwarding
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                          HUB ACCOUNT                                    │
│                                                                         │
│  ┌──────────────────────┐    ┌──────────┐    ┌───────────────────────┐  │
│  │ Hub EventBridge Bus  │───►│ SQS Queue│───►│ Reporter Lambda       │  │
│  └──────────────────────┘    └──────────┘    └────────────┬──────────┘  │
│                                                           │             │
│                                                           ▼             │
│                                                ┌──────────────────────┐ │
│                                                │ DynamoDB Summary     │ │
│                                                │ Table                │ │
│                                                └──────────┬───────────┘ │
│                                                           │             │
│                                                           ▼             │
│                                          ┌─────────────────────────┐    │
│                                          │ Athena DDB Connector    │    │
│                                          │ (federated query)       │    │
│                                          └────────────┬────────────┘    │
│                                                       │                 │
│                                                       ▼                 │
│                                          ┌────────────────────────┐     │
│                                          │ Amazon Managed Grafana │     │
│                                          │ (dashboard)            │     │
│                                          └────────────────────────┘     │
└─────────────────────────────────────────────────────────────────────────┘
```

### Hub Components

- **EventBridge Bus** (`QuotaMonitorBus`): Receives events from all spoke accounts.
- **SQS Queue**: Buffers events for the Reporter Lambda.
- **Reporter Lambda**: Writes quota usage records to DynamoDB (runs every 5 minutes).
- **DynamoDB Summary Table**: Stores all quota usage history with 15-day TTL.
- **SNS Publisher / Slack Notifier**: Sends alerts for WARN and ERROR events.
- **Deployment Manager**: Manages spoke account registration via SSM parameter changes.
- **Grafana + Athena** (optional): Provides SQL-based dashboard over DynamoDB data.

### Spoke Components

- **QuotaListManager**: Custom resource that discovers all quotas with CloudWatch usage metrics for monitored services. Populates the Service and Quota DynamoDB tables.
- **cwPoller Lambda**: Scheduled Lambda that queries CloudWatch `AWS/Usage` metrics for each monitored quota, compares against the threshold, and emits events to the spoke EventBridge bus.
- **Spoke EventBridge Bus** (`QuotaMonitorSpokeBus`): Receives cwPoller events and forwards them to the hub bus.

---

## Data Flow

```
CloudWatch (AWS/Usage metrics)
        │
        ▼
  cwPoller Lambda (spoke)          ← Scheduled: configurable (default 30 min)
        │
        ▼
  Spoke EventBridge Bus
        │
        ▼ (cross-account forwarding rule)
  Hub EventBridge Bus
        │
        ▼
  SQS Queue (buffering)
        │
        ▼
  Reporter Lambda (hub)            ← Scheduled: every 5 minutes
        │
        ▼
  DynamoDB Summary Table           ← Records expire after 15 days (TTL)
        │
        ▼ (federated query via Athena DynamoDB connector)
  Grafana Dashboard
```

### How the cwPoller works

1. Reads all **enabled** services from the Service Table.
2. For each service, fetches monitored quotas from the Quota Table.
3. Queries CloudWatch `GetMetricData` for the `AWS/Usage` namespace.
4. For each returned data point, classifies status:
   - **OK** — usage below threshold
   - **WARN** — usage ≥ threshold but < 100%
   - **ERROR** — usage ≥ 100%
5. Emits events to the spoke EventBridge bus.

**Volume control:** The `OKNotificationLimitCodes` parameter limits which quota codes produce OK events. Without this filter, every monitored quota emits OK events on every poll, which can create a large backlog in the SQS queue (the Reporter processes ~100 messages per invocation).

### DynamoDB Summary Table Schema

| Column | Type | Description |
|--------|------|-------------|
| `MessageId` | String | Partition key (SQS message ID) |
| `TimeStamp` | String | Sort key (ISO 8601) |
| `AccountId` | String | AWS account ID |
| `Region` | String | AWS region |
| `Service` | String | Service name (e.g., EC2, SageMaker) |
| `Resource` | String | Resource dimension |
| `LimitCode` | String | Quota code (e.g., L-1216C47A) |
| `LimitName` | String | Human-readable quota name |
| `CurrentUsage` | String | Usage percentage |
| `LimitAmount` | String | Always "100%" |
| `Status` | String | OK, WARN, or ERROR |
| `Source` | String | Event source identifier |
| `ExpiryTime` | Number | TTL epoch (15 days from write) |

---

## Athena + Grafana Integration

When deployed with `ENABLE_GRAFANA=true` (the default), the hub stack provisions the following additional resources:

### Components

1. **S3 Bucket** (Athena results): Scratch space for Athena query results. Auto-cleaned via 7-day lifecycle rule.

2. **Athena Workgroup** (`QuotaMonitorGrafana`): Dedicated workgroup that isolates Quota Monitor queries and enforces the output location.

3. **Athena DynamoDB Connector** (SAR application): A Lambda function from the AWS Serverless Application Repository that translates Athena SQL queries into DynamoDB scan/query operations.

4. **Athena Data Catalog** (`quota-monitor-ddb`): Registers the DynamoDB connector so Athena can discover and query DynamoDB tables via SQL.

5. **IAM Role for Grafana**: Grants the Managed Grafana workspace permissions across the full query chain: Athena → Glue catalog → DynamoDB connector Lambda → DynamoDB + KMS.

6. **Amazon Managed Grafana Workspace** (`QuotaMonitorDashboard`): SSO-authenticated workspace with Athena as the data source.

### Query Chain

```
Grafana (SQL query)
    → Athena (workgroup: QuotaMonitorGrafana)
        → Athena Data Catalog (quota-monitor-ddb, type: LAMBDA)
            → DynamoDB Connector Lambda (quota-monitor-ddb)
                → DynamoDB Summary Table (KMS-encrypted)
```

In Athena SQL, address the table as:

```sql
SELECT * FROM "quota-monitor-ddb"."default"."<dynamodb-table-name>"
```

The `<dynamodb-table-name>` is the physical DynamoDB table name (visible in the Athena catalog or in CloudFormation outputs).

---

## Grafana Setup Guide

After deployment, follow these steps to set up the dashboard.

### 1. Assign users to the Grafana workspace

The Grafana workspace uses **AWS IAM Identity Center (SSO)** for authentication. Users must be explicitly assigned before they can log in.

1. Open the AWS Console → **Amazon Managed Grafana** → select `QuotaMonitorDashboard`.
2. Go to the **Authentication** tab.
3. Click **Assign new user or group**.
4. Select the SSO user(s) or group(s) that need access.
5. Assign at least one user with the **Admin** role — this user will configure the data source and create dashboards.
6. Additional users can be assigned as **Editor** (can create/edit dashboards) or **Viewer** (read-only).

> **Important:** Without this step, no one can log into the Grafana workspace. IAM Identity Center must be enabled in the account before deployment.

### 2. Add Athena data source in Grafana

1. Open the Grafana workspace URL (from stack output `GrafanaWorkspaceUrl`).
2. Log in via SSO.
3. Go to **Connections** → **Data sources** → **Add data source** → select **Amazon Athena**.
4. Configure:

   | Field | Value |
   |-------|-------|
   | Authentication Provider | Workspace IAM Role |
   | Default Region | *(your deployment region)* |
   | Data Source (catalog) | `quota-monitor-ddb` |
   | Database | `default` |
   | Workgroup | `QuotaMonitorGrafana` |

5. Click **Save & test**.

> **Important:** Fill the fields top-to-bottom. Selecting Database before Catalog causes a validation error.

### 3. Create a dashboard

Go to **Dashboards** → **New dashboard** → **Add visualization**, select the Athena data source, and write SQL queries.

**Example queries:**

```sql
-- Recent quota usage (all services)
SELECT status, service, limitcode, limitname, currentusage, region, timestamp
FROM "default"."<TABLE_NAME>"
ORDER BY timestamp DESC
LIMIT 20

-- Warnings and errors only
SELECT status, service, limitname, currentusage, region, timestamp
FROM "default"."<TABLE_NAME>"
WHERE status IN ('WARN', 'ERROR')
ORDER BY timestamp DESC

-- Count quotas by status
SELECT status, COUNT(*) as count
FROM "default"."<TABLE_NAME>"
GROUP BY status
ORDER BY count DESC
```

Replace `<TABLE_NAME>` with the actual DynamoDB table name as shown in the Athena catalog.

---

## Operational Notes

### Event Volume and SQS Backlog

The Reporter Lambda processes ~100 messages per invocation (every 5 minutes = ~28,800/day). If `MonitoringFrequency=rate(30 minutes)` with `ReportOKNotifications=Yes` and many quotas monitored, event volume can exceed this capacity.

**Recommendations:**

- Use `rate(6 hours)` or `rate(12 hours)` for lower volume.
- Set `OKNotificationLimitCodes` to only the quotas you care about.
- If backlog builds up, purge the queue: `aws sqs purge-queue --queue-url <url>`

### Region Limitations

Amazon Managed Grafana is **not available in all regions**. Supported European regions: `eu-central-1`, `eu-west-1`, `eu-west-2`. If you deploy to an unsupported region (e.g., `eu-north-1`), the `AWS::Grafana::Workspace` resource will fail.

### KMS Considerations

The DynamoDB summary table is encrypted with a customer-managed KMS key. The Athena DynamoDB connector Lambda (deployed via SAR) is granted `kms:Decrypt` through a key policy condition matching `*AthenaDDBCon*` in the principal ARN. This is handled automatically by the stack.

### Modifying Monitored Services

In the spoke account, the cwPoller reads from a DynamoDB **Service Table** that lists which services to monitor. Toggle the `monitored` attribute to `true`/`false` for individual services. The **Quota Table** stores the individual quotas per service.

The QuotaListManager refreshes the quota list every 30 days or on stack updates.

### TTL and Data Retention

Records in the DynamoDB summary table expire after **15 days** via the `ExpiryTime` TTL attribute. This keeps costs bounded but means historical data beyond 15 days is not available in Grafana.
