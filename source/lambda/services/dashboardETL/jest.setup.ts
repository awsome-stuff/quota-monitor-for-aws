// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

process.on("unhandledRejection", (reason) => {
  throw reason;
});
process.env.LOG_LEVEL = "none";
process.env.SEND_METRIC = "Yes";
process.env.SOLUTION_ID = "MyId";
process.env.SOLUTION_UUID = "Uuid";
process.env.METRICS_ENDPOINT = "MyEndpoint";
process.env.DASHBOARD_LIMIT_CODES_PARAMETER = "/QuotaMonitor/DashboardLimitCodes";
process.env.QUOTA_TABLE = "quota-monitor-summary-table";
process.env.DASHBOARD_BUCKET = "quota-monitor-dashboard-bucket";
process.env.CUSTOM_SDK_USER_AGENT = "AwsSolution/SO0005/v6.3.2";
