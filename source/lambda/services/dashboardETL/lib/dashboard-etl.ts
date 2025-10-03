// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { DynamoDBHelper, logger, SSMHelper } from "solutions-utils";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";

export class DashboardETL {
  protected readonly moduleName: string;

  constructor() {
    this.moduleName = <string>__filename.split("/").pop();
  }

  async processQuotaData() {
    const ssmHelper = new SSMHelper();
    const s3Client = new S3Client({ customUserAgent: process.env.CUSTOM_SDK_USER_AGENT });
    const destinationBucket = process.env.DASHBOARD_BUCKET;
    if (!destinationBucket) {
      logger.error({
        label: this.moduleName,
        message: "No destination bucket configured for dashboard",
      });
      return;
    }

    // Get limit codes from SSM parameter
    const limitCodesParam: string[] = await ssmHelper.getParameter(<string>process.env.DASHBOARD_LIMIT_CODES_PARAMETER);
    const limitCodes = limitCodesParam.filter(code => !!code && code.length > 0 && code !== "NOP");

    if (limitCodes.length === 0) {
      logger.info({
        label: this.moduleName,
        message: "No limit codes configured for dashboard",
      });
      return;
    }

    logger.info({
      label: this.moduleName,
      message: `Processing ${limitCodes.length} limit codes: ${limitCodes.join(", ")}`,
    });

    // Process each limit code
    const dashboardData: {[limitCode: string]: any} = {};
    for (const limitCode of limitCodes) {
      const allRecords = await this.scanQuotaTable(limitCode); // Scan DynamoDB table for all records
      const latestRecord = this.getLatestRecordForLimitCode(allRecords);

      if (latestRecord) {
        dashboardData[limitCode] = {
          LimitCode: limitCode,
          LimitName: latestRecord.LimitName,
          LimitAmount: latestRecord.LimitAmount,
          CurrentUsage: latestRecord.CurrentUsage,
          Status: latestRecord.Status,
          LastUpdated: latestRecord.TimeStamp,
          AccountId: latestRecord.AccountId,
          Region: latestRecord.Region,
          Service: latestRecord.Service,
        };
      }
    }

    // Write to S3
    if (Object.keys(dashboardData).length > 0) {
      const s3Key = `dashboard-data/quota-summary`;
      await s3Client.send(new PutObjectCommand({
        Bucket: <string>process.env.DASHBOARD_BUCKET,
        Key: s3Key,
        Body: JSON.stringify(Object.values(dashboardData), null, 2),
        ContentType: "application/json"
      }));

      logger.info({
        label: this.moduleName,
        message: `Written ${Object.keys(dashboardData).length} records to S3: ${s3Key}`,
      });
    }
  }

  private async scanQuotaTable(limitCode: string): Promise<any[]> {
    const ddb = new DynamoDBHelper();
    const items = await ddb.queryQuotaUsageInfosForLimitCode(<string>process.env.QUOTA_TABLE, limitCode);
    return items ?? [];
  }

  private getLatestRecordForLimitCode(records: any[]): any | null {
    const filteredRecords = records.filter(record => !!record.TimeStamp);

    if (filteredRecords.length === 0) {
      return null;
    }

    // Sort by timestamp descending and return the latest
    return filteredRecords.sort((a, b) =>
      new Date(b.TimeStamp).getTime() - new Date(a.TimeStamp).getTime()
    )[0];
  }
}