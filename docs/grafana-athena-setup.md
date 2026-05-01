# Grafana + Athena Setup Guide

How to connect Amazon Managed Grafana to the Quota Monitor DynamoDB summary table
via Athena federated queries.

## Architecture

```
Grafana → Athena (SQL) → DynamoDB Connector Lambda → DynamoDB Summary Table
                ↕
         S3 (query results scratch space)
```

## Prerequisites

- `quota-monitor-hub-no-ou` stack deployed with `-c ENABLE_GRAFANA=true`
- `quota-monitor-sq-spoke` stack deployed (provides the poller that populates the summary table)
- AWS IAM Identity Center (SSO) configured in the account
- Region: `eu-central-1` (Managed Grafana is not available in all regions — see "Region Limitation" below)

## Step 1: Assign yourself as Grafana Admin

1. Open the AWS Console → Amazon Managed Grafana → select the `QuotaMonitorDashboard` workspace
2. Go to the **Authentication** tab
3. Assign your SSO user with the **Admin** role

Without Admin, the Connections menu and data source configuration are not visible in the
Grafana UI.

## Step 2: Attach Athena data source in AWS Console

1. In the same workspace settings page, go to the **Data sources** tab
2. Find **Amazon Athena** and click **Attach** if not already attached

This grants the workspace's service-managed role baseline Athena permissions.

## Step 3: Install the JSON plugin (optional, not used)

If you need the JSON API plugin for other purposes:

1. Go to **Workspace configuration options** tab → enable **Plugin management**
2. In the Grafana UI, go to Administration → Plugins and data → search and install

Note: The `simpod-json-datasource` plugin does **not** support SigV4 authentication,
which is why we use Athena instead of a Lambda Function URL for the data source.

## Step 4: Add Athena data source in Grafana

1. Open the Grafana workspace URL (from stack output `GrafanaWorkspaceUrl`)
2. Log in via SSO
3. Go to **Connections** → **Data sources** → **Add data source** → select **Amazon Athena**
4. Configure (fill in this order, top to bottom):

   | Field                     | Value                    |
   | ------------------------- | ------------------------ |
   | Authentication Provider   | Workspace IAM Role       |
   | Default Region            | eu-central-1             |
   | Data Source (catalog)     | quota-monitor-ddb        |
   | Database                  | default                  |
   | Workgroup                 | QuotaMonitorGrafana      |

5. Click **Save & test**

## Step 5: Create a dashboard

1. Go to **Dashboards** → **New dashboard** → **Add visualization**
2. Select the Athena data source you just created
3. Write a SQL query, for example:

```sql
SELECT status, service, limitname, currentusage, region, timestamp
FROM "default"."quota-monitor-hub-no-ou-qmtable336670b0-1v6aezwyrm2zy"
ORDER BY timestamp DESC
```

The table name is the full DynamoDB table name as shown in the Athena catalog.

## Challenges and Solutions

### Region limitation

Amazon Managed Grafana is not available in `eu-north-1` (Stockholm). Deploying the
`AWS::Grafana::Workspace` resource there fails with:

```
Unrecognized resource types: [AWS::Grafana::Workspace]
```

**Solution**: Deploy the entire stack to a supported region. We chose `eu-central-1`
(Frankfurt). Supported European regions: `eu-central-1`, `eu-west-1`, `eu-west-2`.

### KMS-encrypted DynamoDB table

The DynamoDB summary table is encrypted with a customer-managed KMS key. The Athena
DynamoDB connector Lambda (deployed via SAR) does not have `kms:Decrypt` by default.
Queries fail with:

```
COLUMN_NOT_FOUND: Relation contains no accessible columns
```

**Solution**: Add a KMS key resource policy statement that grants `kms:Decrypt` to the
connector's IAM role. Since the SAR nested stack auto-generates the role name with a
random suffix, we use a wildcard condition:

```typescript
kms.key.addToResourcePolicy(new iam.PolicyStatement({
  principals: [new iam.AnyPrincipal()],
  actions: ["kms:Decrypt"],
  resources: ["*"],
  conditions: {
    "StringLike": {
      "aws:PrincipalArn": `arn:aws:iam::${this.account}:role/*AthenaDDBCon*`,
    },
  },
}));
```

### Athena list permissions must use wildcard resources

The Grafana Athena plugin calls `ListDataCatalogs`, `ListWorkGroups`, and `ListDatabases`
to populate the configuration dropdowns. These actions do not support resource-level
restrictions. If scoped to specific ARNs, the dropdowns fail with permission errors.

**Solution**: Split Athena permissions into two statements — one for query execution
(scoped to specific workgroup/catalog ARNs) and one for list/get operations (using
`Resource: "*"`).

### QuickSight service role does not exist in new accounts

The original stack includes KMS and S3 bucket policies referencing a QuickSight service
role. In accounts where QuickSight has never been set up, this role doesn't exist and
the KMS key creation fails with:

```
Policy contains a statement with one or more invalid principals
```

**Solution**: Guard the Dashboard ETL resources (which include the QuickSight policies)
behind a CDK context flag: `-c ENABLE_DASHBOARD_ETL=false`.

### cdk-nag blocks deployment

The project uses `AwsSolutionsChecks` from cdk-nag. New resources trigger violations:

- `AwsSolutions-IAM4`: Lambda basic execution role is a managed policy
- `AwsSolutions-IAM5`: Wildcard resources in IAM policies
- `AwsSolutions-S1`: S3 bucket without access logging

**Solution**: Add `NagSuppressions` for each flagged resource with a justification.

### Grafana dropdowns error: "catalogName must have length greater than or equal to"

When configuring the Athena data source, expanding the Database dropdown before selecting
a Data Source (catalog) triggers a validation error.

**Solution**: Fill the fields in order — Data Source first, then Database, then Workgroup.


## Testing Queries in Grafana

Once the Athena data source is configured, use the **Explore** view to verify data flows
end to end.

1. In the Grafana sidebar, click **Explore**
2. Select the Athena data source from the dropdown at the top
3. Run the queries below

Note: String values in `WHERE` clauses must use **single quotes** (`'value'`), not double
quotes. Double quotes are reserved for identifiers (table/column names).

### List recent quota usage (all services)

```sql
SELECT status, service, limitcode, limitname, currentusage, region, timestamp
FROM "default"."quota-monitor-hub-no-ou-qmtable336670b0-1v6aezwyrm2zy"
ORDER BY timestamp DESC
LIMIT 20
```

### Filter by status (warnings and errors only)

```sql
SELECT status, service, limitname, currentusage, region, timestamp
FROM "default"."quota-monitor-hub-no-ou-qmtable336670b0-1v6aezwyrm2zy"
WHERE status IN ('WARN', 'ERROR')
ORDER BY timestamp DESC
```

### Filter by specific quota code

```sql
SELECT status, service, limitcode, limitname, currentusage, region, timestamp
FROM "default"."quota-monitor-hub-no-ou-qmtable336670b0-1v6aezwyrm2zy"
WHERE limitcode = 'L-0263D0A3'
ORDER BY timestamp DESC
LIMIT 20
```

### Count quotas by status

```sql
SELECT status, COUNT(*) as count
FROM "default"."quota-monitor-hub-no-ou-qmtable336670b0-1v6aezwyrm2zy"
GROUP BY status
ORDER BY count DESC
```

### Top services by number of monitored quotas

```sql
SELECT service, COUNT(*) as quota_count
FROM "default"."quota-monitor-hub-no-ou-qmtable336670b0-1v6aezwyrm2zy"
GROUP BY service
ORDER BY quota_count DESC
LIMIT 10
```

If these queries return data, the full pipeline is working:
Grafana → Athena → DynamoDB connector → DynamoDB summary table.
