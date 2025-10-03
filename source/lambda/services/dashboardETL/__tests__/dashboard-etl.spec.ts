// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { DashboardETL } from "../lib/dashboard-etl";
import { handler } from "../index";

const getParameterMock = jest.fn();
const queryQuotaUsageInfosForLimitCodeMock = jest.fn();
const s3SendMock = jest.fn();

jest.mock("solutions-utils", () => {
  const originalModule = jest.requireActual("solutions-utils");
  return {
    ...originalModule,
    __esModule: true,
    SSMHelper: function () {
      return {
        getParameter: getParameterMock,
      };
    },
    DynamoDBHelper: function () {
      return {
        queryQuotaUsageInfosForLimitCode: queryQuotaUsageInfosForLimitCodeMock,
      };
    },
  };
});

jest.mock("@aws-sdk/client-s3", () => ({
  S3Client: jest.fn().mockImplementation(() => ({
    send: s3SendMock,
  })),
  PutObjectCommand: jest.fn().mockImplementation((params) => params),
}));

const mockRecords = [
  {
    MessageId: "msg-001",
    TimeStamp: "2024-01-03T10:00:00Z",
    LimitCode: "L-123",
    LimitName: "Test Limit 1",
    LimitAmount: "100",
    CurrentUsage: "80",
    Status: "WARN",
    AccountId: "123456789012",
    Region: "us-east-1",
    Service: "ec2",
  },
  {
    MessageId: "msg-002",
    TimeStamp: "2024-01-01T10:00:00Z",
    LimitCode: "L-123",
    LimitName: "Test Limit 1",
    LimitAmount: "100",
    CurrentUsage: "70",
    Status: "OK",
    AccountId: "123456789012",
    Region: "us-east-1",
    Service: "ec2",
  },
  {
    MessageId: "msg-003",
    TimeStamp: "2024-01-02T10:00:00Z",
    LimitCode: "L-456",
    LimitName: "Test Limit 2",
    LimitAmount: "50",
    CurrentUsage: "45",
    Status: "WARN",
    AccountId: "123456789012",
    Region: "us-west-2",
    Service: "s3",
  },
];

describe("DashboardETL", () => {
  let dashboardETL: DashboardETL;

  beforeAll(() => {
    process.env.DASHBOARD_LIMIT_CODES_PARAMETER = "/test/limit-codes";
    process.env.QUOTA_TABLE = "test-quota-table";
    process.env.DASHBOARD_BUCKET = "test-dashboard-bucket";
  });

  beforeEach(() => {
    dashboardETL = new DashboardETL();
    jest.clearAllMocks();
  });

  it("should process quota data successfully", async () => {
    getParameterMock.mockResolvedValue(["L-123", "L-456"]);
    queryQuotaUsageInfosForLimitCodeMock
      .mockResolvedValueOnce([mockRecords[0], mockRecords[1]])
      .mockResolvedValueOnce([mockRecords[2]]);
    s3SendMock.mockResolvedValue({});

    await dashboardETL.processQuotaData();

    expect(getParameterMock).toHaveBeenCalledWith("/test/limit-codes");
    expect(queryQuotaUsageInfosForLimitCodeMock).toHaveBeenCalledTimes(2);
    expect(queryQuotaUsageInfosForLimitCodeMock).toHaveBeenCalledWith("test-quota-table", "L-123");
    expect(queryQuotaUsageInfosForLimitCodeMock).toHaveBeenCalledWith("test-quota-table", "L-456");
    expect(s3SendMock).toHaveBeenCalledTimes(1);
  });

  it("should skip processing when no limit codes configured", async () => {
    getParameterMock.mockResolvedValue(["NOP"]);

    await dashboardETL.processQuotaData();

    expect(getParameterMock).toHaveBeenCalledWith("/test/limit-codes");
    expect(queryQuotaUsageInfosForLimitCodeMock).not.toHaveBeenCalled();
    expect(s3SendMock).not.toHaveBeenCalled();
  });

  it("should handle empty limit codes array", async () => {
    getParameterMock.mockResolvedValue([]);

    await dashboardETL.processQuotaData();

    expect(queryQuotaUsageInfosForLimitCodeMock).not.toHaveBeenCalled();
    expect(s3SendMock).not.toHaveBeenCalled();
  });

  it("should get latest record for limit code", async () => {
    getParameterMock.mockResolvedValue(["L-123"]);
    queryQuotaUsageInfosForLimitCodeMock.mockResolvedValue([mockRecords[0], mockRecords[1]]);
    s3SendMock.mockResolvedValue({});

    await dashboardETL.processQuotaData();

    expect(s3SendMock).toHaveBeenCalledWith(
      expect.objectContaining({
        Bucket: "test-dashboard-bucket",
        Key: expect.stringMatching(/^dashboard-data\/quota-summary$/),
        Body: expect.stringContaining('"LastUpdated": "2024-01-03T10:00:00Z"'),
        ContentType: "application/json",
      })
    );
  });

  it("should handle no records found for limit code", async () => {
    getParameterMock.mockResolvedValue(["L-999"]);
    queryQuotaUsageInfosForLimitCodeMock.mockResolvedValue([]);

    await dashboardETL.processQuotaData();

    expect(s3SendMock).not.toHaveBeenCalled();
  });

  it("should handle records without timestamp", async () => {
    const recordsWithoutTimestamp = [
      { ...mockRecords[0], TimeStamp: undefined },
      { ...mockRecords[1], TimeStamp: null },
    ];
    
    getParameterMock.mockResolvedValue(["L-123"]);
    queryQuotaUsageInfosForLimitCodeMock.mockResolvedValue(recordsWithoutTimestamp);

    await dashboardETL.processQuotaData();

    expect(s3SendMock).not.toHaveBeenCalled();
  });

  it("should handle a scheduled event", async () => {
    getParameterMock.mockResolvedValue(["L-123"]);
    queryQuotaUsageInfosForLimitCodeMock.mockResolvedValue([mockRecords[0]]);
    s3SendMock.mockResolvedValue({});

    await handler({});

    expect(getParameterMock).toHaveBeenCalled();
    expect(s3SendMock).toHaveBeenCalled();
  });
});