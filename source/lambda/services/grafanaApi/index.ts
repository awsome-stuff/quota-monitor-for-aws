// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, ScanCommand } from "@aws-sdk/lib-dynamodb";
import { logger } from "solutions-utils";

const MODULE_NAME = __filename.split("/").pop();

/**
 * @description Lambda Function URL handler that returns summary table data as JSON
 * for consumption by Grafana's JSON API data source plugin
 */
export const handler = async (event: any) => {
  logger.debug({
    label: `${MODULE_NAME}/handler`,
    message: JSON.stringify(event),
  });

  try {
    const client = new DynamoDBClient({
      customUserAgent: process.env.CUSTOM_SDK_USER_AGENT,
    });
    const ddbDocClient = DynamoDBDocumentClient.from(client, {
      marshallOptions: { removeUndefinedValues: true },
    });

    const tableName = <string>process.env.QUOTA_TABLE;
    const allItems: Record<string, any>[] = [];
    let lastEvaluatedKey: Record<string, any> | undefined;

    do {
      const response = await ddbDocClient.send(
        new ScanCommand({
          TableName: tableName,
          ExclusiveStartKey: lastEvaluatedKey,
        })
      );
      if (response.Items) {
        allItems.push(...response.Items);
      }
      lastEvaluatedKey = response.LastEvaluatedKey;
    } while (lastEvaluatedKey);

    const records = allItems.map((item) => ({
      MessageId: item.MessageId,
      TimeStamp: item.TimeStamp,
      AccountId: item.AccountId,
      CurrentUsage: item.CurrentUsage,
      LimitAmount: item.LimitAmount,
      LimitCode: item.LimitCode,
      LimitName: item.LimitName,
      Region: item.Region,
      Resource: item.Resource ?? "",
      Service: item.Service,
      Source: item.Source,
      Status: item.Status,
    }));

    logger.info({
      label: `${MODULE_NAME}/handler`,
      message: `Returning ${records.length} records`,
    });

    return {
      statusCode: 200,
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(records),
    };
  } catch (error) {
    logger.error({
      label: `${MODULE_NAME}/handler`,
      message: `Error scanning table: ${error}`,
    });

    return {
      statusCode: 500,
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ error: "Failed to retrieve quota data" }),
    };
  }
};
