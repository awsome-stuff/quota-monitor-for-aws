# Athena DynamoDB Integration Test

Verification that the Athena federated query setup can successfully read the Quota Monitor
summary DynamoDB table through the DynamoDB connector.

## Prerequisites

- AWS CLI authenticated with the Frankfurt (`eu-central-1`) account
- The `quota-monitor-hub-no-ou` stack deployed with `-c ENABLE_GRAFANA=true`

## Test Steps

### 1. Verify the Athena data catalog exists

```bash
aws athena list-data-catalogs \
  --query "DataCatalogsSummary[?CatalogName=='quota-monitor-ddb']" \
  --output json
```

Expected: a catalog of type `LAMBDA` with status `CREATE_COMPLETE`.

### 2. Verify the Athena workgroup exists

```bash
aws athena get-work-group \
  --work-group QuotaMonitorGrafana \
  --query "WorkGroup.Name" \
  --output text
```

Expected: `QuotaMonitorGrafana`

### 3. Verify the DynamoDB connector Lambda exists

```bash
aws lambda get-function \
  --function-name quota-monitor-ddb \
  --query "Configuration.FunctionName" \
  --output text
```

Expected: `quota-monitor-ddb`

### 4. List DynamoDB tables visible through the catalog

```bash
QUERY_ID=$(aws athena start-query-execution \
  --query-string "SHOW TABLES IN \`default\`" \
  --query-execution-context "Catalog=quota-monitor-ddb" \
  --work-group QuotaMonitorGrafana \
  --query "QueryExecutionId" --output text)

sleep 5

aws athena get-query-results --query-execution-id $QUERY_ID --output json
```

Expected: a list of DynamoDB table names including the summary table
(`quota-monitor-hub-no-ou-qmtable336670b0-*`).

### 5. Query the summary table

Replace `TABLE_NAME` with the actual summary table name from step 4.

```bash
QUERY_ID=$(aws athena start-query-execution \
  --query-string "SELECT * FROM \"default\".\"TABLE_NAME\" LIMIT 5" \
  --query-execution-context "Catalog=quota-monitor-ddb" \
  --work-group QuotaMonitorGrafana \
  --query "QueryExecutionId" --output text)

sleep 10

aws athena get-query-execution \
  --query-execution-id $QUERY_ID \
  --query "QueryExecution.Status.State" \
  --output text
```

Expected: `SUCCEEDED`

Then retrieve the results:

```bash
aws athena get-query-results --query-execution-id $QUERY_ID --output json
```

Expected: rows containing quota usage data with columns: `status`, `currentusage`,
`accountid`, `limitamount`, `resource`, `service`, `expirytime`, `limitcode`, `source`,
`limitname`, `timestamp`, `region`, `messageid`.

## Test Results (2026-04-30)

All steps passed. Sample data returned:

| status | service                        | limitname                                           | currentusage | region       |
| ------ | ------------------------------ | ------------------------------------------------+-- | ------------ | ------------ |
| OK     | SageMaker                      | Studio KernelGateway Apps running on ml.t3.xlarge   | 0%           | eu-central-1 |
| OK     | Logs                           | GetLogEvents throttle limit in TPS                  | 0%           | eu-central-1 |
| OK     | MediaConvert                   | Request rate for CreatePreset                       | 0%           | eu-central-1 |
| OK     | CloudWatch Application Signals | Rate of StartDiscovery requests                     | 0%           | eu-central-1 |
| OK     | SageMaker                      | RSessionGateway Apps running on ml.m5d.8xlarge      | 0%           | eu-central-1 |

## Troubleshooting

If step 5 fails with `COLUMN_NOT_FOUND: Relation contains no accessible columns`, the
connector Lambda likely lacks `kms:Decrypt` permission on the KMS key used to encrypt the
DynamoDB table. Verify the KMS key policy includes a statement allowing the connector's
IAM role to decrypt.
