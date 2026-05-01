# Quota Monitor Data Flow Architecture

End-to-end flow from CloudWatch metrics to the DynamoDB summary table.

## Overview

```
CloudWatch (AWS/Usage metrics)
        ↓
   cwPoller Lambda (spoke)
        ↓
   Spoke EventBridge Bus
        ↓
   Hub EventBridge Bus
        ↓
   SQS Queue
        ↓
   Reporter Lambda (hub)
        ↓
   DynamoDB Summary Table
```

## Components

### 1. cwPoller Lambda (Spoke Stack)

**Location**: `source/lambda/services/cwPoller/`
**Trigger**: EventBridge Schedule (configurable via `MonitoringFrequency` CloudFormation
parameter). Allowed values: `rate(6 hours)`, `rate(12 hours)`, `rate(1 day)`,
`rate(30 minutes)`. Default: `rate(30 minutes)`.
**Timeout**: 15 minutes

What it does:
1. Reads all enabled services from the Service Table (DynamoDB)
2. For each service, fetches monitored quotas from the Quota Table (DynamoDB)
3. Generates CloudWatch `GetMetricData` queries for each quota's usage metric
4. Queries CloudWatch (`AWS/Usage` namespace) for utilization data over the polling window
5. For each data point returned, creates a utilization event with status:
   - `OK` — usage below threshold
   - `WARN` — usage above threshold but below 100%
   - `ERROR` — usage at or above 100%
6. Sends events to the Spoke EventBridge Bus

**Key detail**: The cwPoller queries CloudWatch using two time parameters:
- **Query window**: how far back to look. Determined by `POLLER_FREQUENCY` — 6h, 12h, or
  24h. Note: `rate(30 minutes)` has no matching case in the code and falls through to the
  24-hour default, meaning it queries 24 hours of data every 30 minutes.
- **Metric period**: the aggregation bucket size. Controlled by the `METRIC_STATS_PERIOD`
  constant (3600 seconds = 1 hour). CloudWatch returns one aggregated value per period
  within the query window. So a 24-hour window with a 1-hour period returns up to 24
  data points per quota. Each data point becomes one event sent to EventBridge.

**Environment variables**:
- `POLLER_FREQUENCY` — determines the CloudWatch query time window (6h, 12h, or 24h)
- `THRESHOLD` — percentage threshold for WARN status (default: 80)
- `REPORT_OK_NOTIFICATIONS` — `Yes`/`No`, whether to emit OK events
- `OK_NOTIFICATION_LIMIT_CODES` — comma-separated list of quota codes for which OK events
  are emitted. If empty and `REPORT_OK_NOTIFICATIONS=Yes`, all OK events are emitted.
  WARN and ERROR events are always emitted regardless of this setting.

### 2. Spoke EventBridge Bus

**Name**: `QuotaMonitorSpokeBus`
**Stack**: Spoke

Receives utilization events from the cwPoller. An EventBridge rule forwards matching
events to the Hub EventBridge Bus. The rule filters on:
- Source: `aws-solutions.quota-monitor`
- Detail type: `Service Quotas Utilization Notification`
- Status: `OK`, `WARN`, `ERROR` (when `ReportOKNotifications=Yes`) or `WARN`, `ERROR` only

### 3. Hub EventBridge Bus

**Name**: `QuotaMonitorBus`
**Stack**: Hub (hub-no-ou)

Receives forwarded events from the spoke bus. An EventBridge rule routes matching events
to the SQS queue for the summarizer.

### 4. SQS Queue (Summarizer Event Queue)

**Stack**: Hub
**Encryption**: KMS (customer-managed key)

Buffers events between EventBridge and the Reporter Lambda. This decouples the event
ingestion rate from the processing rate.

**Capacity concern**: With `REPORT_OK_NOTIFICATIONS=Yes` and many monitored quotas, the
queue can accumulate hundreds of thousands of messages. The Reporter processes only 100
messages per invocation (every 5 minutes), so a large backlog can take hours or days to
drain. Use `OK_NOTIFICATION_LIMIT_CODES` to limit OK event volume, or purge the queue
if a backlog builds up:

```bash
aws sqs purge-queue --queue-url <queue-url>
```

### 5. Reporter Lambda (Hub Stack)

**Location**: `source/lambda/services/reporter/`
**Trigger**: EventBridge Schedule — `rate(5 minutes)`
**Timeout**: 10 seconds

What it does:
1. Polls the SQS queue in a loop: `MAX_LOOPS` (10) × `MAX_MESSAGES` (10) = 100 messages
   per invocation
2. For each message, extracts the utilization event payload and writes a record to the
   DynamoDB summary table
3. Deletes the message from SQS after successful write

**SQS constraint**: The SQS `ReceiveMessage` API returns a maximum of 10 messages per
call. This is a hard AWS limit. Throughput is increased by calling it multiple times
(`MAX_LOOPS`).

### 6. DynamoDB Summary Table

**Stack**: Hub
**Table name pattern**: `quota-monitor-hub-no-ou-QMTable*`
**Encryption**: KMS (customer-managed key)
**TTL**: `ExpiryTime` attribute — records expire after 15 days

Schema per record:

| Attribute    | Type   | Description                                    |
| ------------ | ------ | ---------------------------------------------- |
| MessageId    | String | Partition key (SQS message ID)                 |
| TimeStamp    | String | Sort key (ISO 8601 timestamp of the data point)|
| AccountId    | String | AWS account ID                                 |
| Region       | String | AWS region                                     |
| Service      | String | Service name (e.g., EC2, SageMaker)            |
| Resource     | String | Resource dimension (e.g., vCPU)                |
| LimitCode    | String | Quota code (e.g., L-1216C47A)                  |
| LimitName    | String | Human-readable quota name                      |
| CurrentUsage | String | Usage percentage (e.g., "0.87%")               |
| LimitAmount  | String | Always "100%" (max utilization)                |
| Status       | String | OK, WARN, or ERROR                             |
| Source       | String | Event source identifier                        |
| ExpiryTime   | Number | TTL epoch timestamp (15 days from write)       |

**Global Secondary Index**: `LimitCodeIndex` — partition key `LimitCode`, sort key
`TimeStamp`. Used by the dashboard ETL to query records by quota code.

## Timing Summary

| Component       | Frequency / Trigger     | Throughput per run              |
| --------------- | ----------------------- | ------------------------------- |
| cwPoller        | Configurable (default: 30 min) | ~N quotas × up to 24 data points |
| Spoke → Hub bus | Real-time (EventBridge) | Immediate forwarding            |
| SQS queue       | Passive buffer          | Unlimited capacity              |
| Reporter        | Every 5 min             | 100 messages (10 loops × 10)   |
| DynamoDB TTL    | Background              | Records expire after 15 days   |

## Event Volume Estimates

The cwPoller asks CloudWatch: "give me usage data for the last N hours, aggregated in
1-hour buckets." So a 24-hour query window returns up to 24 values (one per hour), and
each value becomes one event sent to EventBridge.

| Polling Frequency | CW Query Window | Data Points per Quota | Events per Run (32 quotas) | Events per Day |
| ----------------- | --------------- | --------------------- | -------------------------- | -------------- |
| rate(30 minutes)  | 24 hours\*      | 24                    | ~768                       | ~36,864        |
| rate(6 hours)     | 6 hours         | 6                     | ~192                       | ~768           |
| rate(12 hours)    | 12 hours        | 12                    | ~384                       | ~768           |
| rate(1 day)       | 24 hours        | 24                    | ~768                       | ~768           |

\* The 30-minute schedule uses a 24-hour query window (the default fallback in the code).

The "Events per Run" and "Events per Day" columns are **upper bounds** assuming all 32
quotas have CloudWatch usage data for every hour in the window. In practice, quotas with
zero usage return no data points, so actual event counts will be lower.

**With `REPORT_OK_NOTIFICATIONS=Yes` and no `OK_NOTIFICATION_LIMIT_CODES` filter**,
all events (OK + WARN + ERROR) are sent. Since most quotas report OK most of the time,
nearly all events are OK events.

**Reporter processing capacity**: 100 messages every 5 minutes = 28,800 messages/day.
At `rate(30 minutes)`, the poller generates ~36,864 events/day — exceeding the Reporter's
capacity and causing a growing queue backlog.

**Recommendation**: When using `rate(30 minutes)`, either:
- Set `REPORT_OK_NOTIFICATIONS=No` (only WARN/ERROR events, much lower volume)
- Set `OK_NOTIFICATION_LIMIT_CODES` to a small list of codes you care about
- Increase `MAX_LOOPS` and the Reporter timeout to process more messages per run

## Data Absence

If a quota has no CloudWatch usage data (e.g., zero running instances for that instance
type), the cwPoller gets no data points from `GetMetricData`, creates no events, and
nothing reaches the summary table. The quota will only appear in the summary table when
there is actual resource usage to report.
