// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { DashboardETL } from "./lib/dashboard-etl";
import { logger } from "solutions-utils";

const MODULE_NAME = __filename.split("/").pop();

export const handler = async (event: any) => {
  logger.debug({
    label: `${MODULE_NAME}/handler`,
    message: JSON.stringify(event),
  });

  const dashboardETL = new DashboardETL();
  await dashboardETL.processQuotaData();
};