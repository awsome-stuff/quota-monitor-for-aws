// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { MetricInfo, ServiceQuota } from "@aws-sdk/client-service-quotas";
import { MetricDataQuery, MetricDataResult } from "@aws-sdk/client-cloudwatch";
import { PutEventsRequestEntry } from "@aws-sdk/client-cloudwatch-events";
import {
  CloudWatchHelper,
  DynamoDBHelper,
  EventsHelper,
  ServiceQuotasHelper,
  stringEqualsIgnoreCase,
  logger,
} from "solutions-utils";

/**
 * @description period of 1hr for metric stats
 */
export const METRIC_STATS_PERIOD = 3600;

/**
 * @description supported frequencies for cw poller in hours
 */
export enum FREQUENCY {
  "06_HOUR" = "rate(6 hours)",
  "12_HOUR" = "rate(12 hours)",
  "24_HOUR" = "rate(1 day)",
}

/**
 * @description status for quota utilization events
 */
export enum QUOTA_STATUS {
  OK = "OK",
  WARN = "WARN",
  ERROR = "ERROR",
}

/**
 * @description support quota utilization event format to be sent on bridge
 */
interface IQuotaUtilizationEvent {
  status: QUOTA_STATUS;
  "check-item-detail": {
    "Limit Code": string;
    "Limit Name": string;
    Resource: string;
    Service: string;
    Region: string;
    "Current Usage": string;
    "Limit Amount": string;
    Timestamp?: Date;
  };
}

/**
 * @description get frequency in hours
 * @param rate
 * @returns
 */
function getFrequencyInHours(rate: string = <string>process.env.POLLER_FREQUENCY) {
  if (rate == FREQUENCY["06_HOUR"]) return 6;
  if (rate == FREQUENCY["12_HOUR"]) return 12;
  else return 24; // default frequency 24 hours
}

/**
 * @description scan quota table and gets quotas to monitor for utilization
 * @param table quota table to scan for quota items
 * @param service service for which to fetch quotas
 * @returns
 */
export async function getQuotasForService(table: string, service: string) {
  const ddb = new DynamoDBHelper();
  const items = await ddb.queryQuotasForService(table, service);
  return items ?? [];
}

/**
 * @description generates CW GetMetricData queries for all quotas
 * @param quotas
 */
export function generateCWQueriesForAllQuotas(quotas: ServiceQuota[]) {
  const sq = new ServiceQuotasHelper();
  const queries: MetricDataQuery[] = [];
  quotas.forEach((quota) => {
    try {
      queries.push(...sq.generateCWQuery(quota, METRIC_STATS_PERIOD));
    } catch (_) {
      // quota throws error with generating query
    }
  });
  return queries;
}

export type MetricQueryIdToQuotaMap = { [key: string]: ServiceQuota };

/**
 * generates a map of metric query ids and the corresponding quota objects from which the ids are generated
 * @param quotas
 */
export function generateMetricQueryIdMap(quotas: ServiceQuota[]) {
  const sq = new ServiceQuotasHelper();
  const dict: MetricQueryIdToQuotaMap = {};
  for (const quota of quotas) {
    const metricQueryId = sq.generateMetricQueryId(<MetricInfo>quota.UsageMetric, quota.QuotaCode);
    dict[metricQueryId] = quota;
  }
  return dict;
}

/**
 * @description get all metric data points for quota utilization
 * @param queries
 * @returns
 */
export async function getCWDataForQuotaUtilization(queries: MetricDataQuery[]) {
  const cw = new CloudWatchHelper();
  const BATCH_SIZE = 100;
  const allDataPoints = [];

  const batchQueries = (queries: MetricDataQuery[]): MetricDataQuery[][] => {
    const batches: MetricDataQuery[][] = [];

    while (queries.length > 0) {
      batches.push(queries.splice(0, BATCH_SIZE));
    }

    return batches;
  };

  const batches = batchQueries(queries);

  for (const batch of batches) {
    const dataPoints = await executeGetMetricDataWithRetry(cw, batch);
    allDataPoints.push(...dataPoints);
  }

  logger.debug({
    label: "getCWDataForQuotaUtilization",
    message: `Returning ${allDataPoints.length} metric results: ${JSON.stringify(allDataPoints.map(dp => ({ Id: dp.Id, Label: dp.Label, ValuesCount: dp.Values?.length ?? 0 })))}`,
  });

  return allDataPoints;
}

/**
 * @description Executes GetMetricData with retry logic. If a ValidationError occurs,
 * extracts the failing metric query ID from the error message, removes it from the batch,
 * and retries. Repeats until the batch succeeds or no more failing metrics can be identified.
 *
 * Background: CloudWatch's GetMetricData API rejects the ENTIRE batch if any single
 * metric expression is invalid. This commonly happens when a quota's SERVICE_QUOTA()
 * expression has no association registered in CloudWatch for the target region — even
 * though Service Quotas advertises the quota with a UsageMetric. For example, L-0263D0A3
 * (EC2-VPC Elastic IPs) in eu-central-1 triggers:
 *   "Error in expression '...': Parameter metric is invalid. There is no service quota
 *    associated to this metric."
 * Without this retry, one bad metric kills utilization reporting for ALL quotas in the batch.
 */
async function executeGetMetricDataWithRetry(cw: CloudWatchHelper, batch: MetricDataQuery[]): Promise<MetricDataResult[]> {
  const MAX_RETRIES = 10;
  let currentBatch = [...batch];

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const dataPoints = await cw.getMetricData(
        new Date(Date.now() - getFrequencyInHours() * 60 * 60 * 1000),
        new Date(),
        currentBatch
      );
      return dataPoints;
    } catch (error) {
      const failingQueryId = extractFailingQueryIdFromError(error);

      if (!failingQueryId) {
        // Cannot identify the failing metric, log and give up on this batch
        logger.error({
          label: "getCWDataForQuotaUtilization/retry",
          message: `Batch failed with non-recoverable error: ${error.name} - ${error.message}`,
        });
        return [];
      }

      // Remove the failing metric queries (both the raw metric and the _pct_utilization expression)
      const baseId = failingQueryId.replace("_pct_utilization", "");
      const beforeCount = currentBatch.length;
      currentBatch = currentBatch.filter(
        (q) => q.Id !== baseId && q.Id !== `${baseId}_pct_utilization`
      );
      const removedCount = beforeCount - currentBatch.length;

      logger.debug({
        label: "getCWDataForQuotaUtilization/retry",
        message: `Attempt ${attempt + 1}: Excluding failing metric '${baseId}' (removed ${removedCount} queries). Remaining queries: ${currentBatch.length}`,
      });

      if (currentBatch.length === 0) {
        logger.error({
          label: "getCWDataForQuotaUtilization/retry",
          message: `All queries removed after retries, no data to fetch`,
        });
        return [];
      }
    }
  }

  logger.error({
    label: "getCWDataForQuotaUtilization/retry",
    message: `Exceeded max retries (${MAX_RETRIES}), returning empty results`,
  });
  return [];
}

/**
 * @description Extracts the failing metric query ID from a CloudWatch ValidationError message.
 * Expected format: "Error in expression 'some_metric_id': Parameter metric is invalid..."
 */
function extractFailingQueryIdFromError(error: any): string | null {
  if (!error.message) return null;
  const match = error.message.match(/Error in expression '([^']+)'/);
  return match ? match[1] : null;
}

/**
 * @description returns the metric query id from the result query id
 * @param metricData
 */
function getMetricQueryIdFromMetricData(metricData: Omit<MetricDataResult, "Label">) {
  return (<string>metricData.Id).split("_pct_utilization")[0];
}

/**
 * @description evaluate metric data and create quota utilization events
 * @param metricData
 * @param metricQueryIdToQuotaMap
 */
export function createQuotaUtilizationEvents(
  metricData: MetricDataResult,
  metricQueryIdToQuotaMap: MetricQueryIdToQuotaMap
) {
  const metricQueryId = getMetricQueryIdFromMetricData(metricData);
  const quota = metricQueryIdToQuotaMap[metricQueryId];
  const utilizationValues = <number[]>metricData.Values;

  const items: IQuotaUtilizationEvent[] = [];

  const sendOKNotifications = stringEqualsIgnoreCase(<string>process.env.REPORT_OK_NOTIFICATIONS, "Yes");
  const okLimitCodesEnv = process.env.OK_NOTIFICATION_LIMIT_CODES || "";
  const okLimitCodes = okLimitCodesEnv
    .split(",")
    .map((code) => code.trim())
    .filter((code) => code.length > 0);

  utilizationValues.forEach((value, index) => {
    const quotaEvents: IQuotaUtilizationEvent = {
      status: QUOTA_STATUS.OK,
      "check-item-detail": {
        "Limit Code": <string>quota.QuotaCode,
        "Limit Name": <string>quota.QuotaName,
        Resource: <string>quota.UsageMetric?.MetricDimensions?.Resource,
        Service: <string>quota.UsageMetric?.MetricDimensions?.Service,
        Region: <string>process.env.AWS_REGION,
        "Current Usage": "",
        "Limit Amount": "100%", // max utilization is 100%
      },
    };
    if (value >= 100) {
      quotaEvents.status = QUOTA_STATUS.ERROR;
    } else if (value > +(<string>process.env.THRESHOLD)) {
      quotaEvents.status = QUOTA_STATUS.WARN;
    } else {
      quotaEvents.status = QUOTA_STATUS.OK;
    }
    quotaEvents["check-item-detail"]["Current Usage"] = "" + value + "%";
    quotaEvents["check-item-detail"].Timestamp = (<Date[]>metricData.Timestamps)[index];

    // Always emit WARN and ERROR events.
    // For OK events: emit only if REPORT_OK_NOTIFICATIONS is Yes AND either
    // no specific limit codes are configured (report all) or this quota's
    // code is in the OK_NOTIFICATION_LIMIT_CODES list.
    // This is necessary to avoid flooding the SQS queue with too many messages.
    const isOK = quotaEvents.status === QUOTA_STATUS.OK;
    const okAllowed = sendOKNotifications && (okLimitCodes.length === 0 || okLimitCodes.includes(<string>quota.QuotaCode));
    if (!isOK || okAllowed) {
      items.push(quotaEvents);
    }
  });

  return items;
}

export function createTestQuotaUtilizationEvents(testStatus: QUOTA_STATUS) {
  let usage: string;

  if (testStatus == QUOTA_STATUS.WARN) {
    usage = process.env.THRESHOLD + "%";
  } else {
    usage = "100%";
  }
  const quotaEvents: IQuotaUtilizationEvent[] = [
    {
      status: testStatus,
      "check-item-detail": {
        "Limit Code": "L-testquota",
        "Limit Name": "QM Test Quota",
        Resource: "QM test resource",
        Service: "QmTestService",
        Region: "qm-test-region",
        "Current Usage": usage,
        "Limit Amount": "100%", // max utilization is 100%
        Timestamp: new Date(),
      },
    },
  ];

  return quotaEvents;
}
/**
 * @description send events to spoke event bridge for quota utilization
 * @param eventBridge event bridge to receive the events
 * @param utilizationEvents utilization events to send to bridge
 */
export async function sendQuotaUtilizationEventsToBridge(
  eventBridge: string,
  utilizationEvents: IQuotaUtilizationEvent[]
) {
  const events = new EventsHelper();
  const putEventEntries: PutEventsRequestEntry[] = [];
  utilizationEvents.forEach((event) => {
    putEventEntries.push({
      Source: "aws-solutions.quota-monitor",
      DetailType: "Service Quotas Utilization Notification",
      Detail: JSON.stringify(event),
      EventBusName: eventBridge,
    });
  });
  await events.putEvent(putEventEntries);
}
