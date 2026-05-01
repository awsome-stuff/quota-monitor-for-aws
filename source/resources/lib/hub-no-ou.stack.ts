// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  aws_iam as iam,
  aws_dynamodb as dynamodb,
  aws_events as events,
  aws_sns as sns,
  aws_ssm as ssm,
  aws_s3 as s3,
  aws_grafana as grafana,
  aws_athena as athena,
  aws_sam as sam,
  App,
  CfnCondition,
  CfnParameter,
  CfnMapping,
  CfnOutput,
  Duration,
  Fn,
  Stack,
  Aspects,
  StackProps,
} from "aws-cdk-lib";
import { Subscription } from "aws-cdk-lib/aws-sns";
import { addCfnGuardSuppression, addCfnGuardSuppressionToNestedResources } from "./cfn-guard-utils";
import { NagSuppressions } from "cdk-nag";
import * as path from "path";
import { ConditionAspect } from "./condition.utils";
import { CustomResourceLambda } from "./custom-resource-lambda.construct";
import { EventsToLambda } from "./events-lambda.construct";
import { EventsToSQS } from "./events-sqs.construct";
import { EVENT_NOTIFICATION_DETAIL_TYPE, EVENT_NOTIFICATION_SOURCES, LOG_LEVEL } from "./exports";
import { Layer } from "./lambda-layer.construct";
import { EventsToLambdaToSNS } from "./events-lambda-sns.construct";
import { KMS } from "./kms.construct";

/**
 * @description
 * This is the Hub Stack for Quota Monitor for AWS
 * The stack should be deployed in the monitoring account
 * Use it when you are not using AWS Organizations
 * @author aws-solutions
 */

export class QuotaMonitorHubNoOU extends Stack {
  /**
   * @param {App} scope - parent of the construct
   * @param {string} id - identifier for the object
   */
  constructor(scope: App, id: string, props: StackProps) {
    super(scope, id, props);

    //=============================================================================================
    // Parameters
    //=============================================================================================
    const snsEmail = new CfnParameter(this, "SNSEmail", {
      description: "To disable email notifications, leave this blank.",
      type: "String",
      default: "",
    });

    const slackNotification = new CfnParameter(this, "SlackNotification", {
      allowedValues: ["Yes", "No"],
      default: "No",
    });

    const reportOKNotifications = new CfnParameter(this, "ReportOKNotifications", {
      type: "String",
      default: "Yes",
      allowedValues: ["Yes", "No"],
    });

    const dashboardETLFrequency = new CfnParameter(this, "DashboardETLFrequency", {
      type: "String",
      default: "rate(5 minutes)",
      allowedValues: ["rate(5 minutes)", "rate(15 minutes)", "rate(30 minutes)", "rate(1 hour)"],
      description: "Frequency to run dashboard ETL process",
    });

    //=============================================================================================
    // Mapping & Conditions
    //=============================================================================================
    const map = new CfnMapping(this, "QuotaMonitorMap");
    map.setValue("Metrics", "SendAnonymizedData", this.node.tryGetContext("SEND_METRICS"));
    map.setValue("Metrics", "MetricsEndpoint", this.node.tryGetContext("METRICS_ENDPOINT"));
    map.setValue("SSMParameters", "SlackHook", "/QuotaMonitor/SlackHook");
    map.setValue("SSMParameters", "Accounts", "/QuotaMonitor/Accounts");
    map.setValue("SSMParameters", "NotificationMutingConfig", "/QuotaMonitor/NotificationConfiguration");
    map.setValue("SSMParameters", "DashboardLimitCodes", "/QuotaMonitor/DashboardLimitCodes");

    const emailTrue = new CfnCondition(this, "EmailTrueCondition", {
      expression: Fn.conditionNot(Fn.conditionEquals(snsEmail.valueAsString, "")),
    });

    const slackTrue = new CfnCondition(this, "SlackTrueCondition", {
      expression: Fn.conditionEquals(slackNotification.valueAsString, "Yes"),
    });

    const reportOKNotificationsCondition = new CfnCondition(this, "ReportOKNotificationsCondition", {
      expression: Fn.conditionEquals(reportOKNotifications.valueAsString, "Yes"),
    });

    //=============================================================================================
    // Metadata
    //=============================================================================================
    this.templateOptions.metadata = {
      "AWS::CloudFormation::Interface": {
        ParameterGroups: [
          {
            Label: {
              default: "Notification Configuration",
            },
            Parameters: ["SNSEmail", "SlackNotification", "ReportOKNotifications"],
          },
          {
            Label: {
              default: "Dashboard Configuration",
            },
            Parameters: ["DashboardETLFrequency"],
          },
        ],
        ParameterLabels: {
          SNSEmail: {
            default: "Email address for notifications",
          },
          SlackNotification: {
            default: "Do you want slack notifications?",
          },
          ReportOKNotifications: {
            default: "Report OK Notifications",
          },
          DashboardETLFrequency: {
            default: "Dashboard ETL Frequency",
          },
        },
      },
    };
    this.templateOptions.description = `(${this.node.tryGetContext("SOLUTION_ID")}-NoOU) - ${this.node.tryGetContext(
      "SOLUTION_NAME"
    )} - Hub Template, use it when you are not using AWS Organizations. Version ${this.node.tryGetContext(
      "SOLUTION_VERSION"
    )}`;
    this.templateOptions.templateFormatVersion = "2010-09-09";

    //=============================================================================================
    // Resources
    //=============================================================================================

    //=========================
    // Common shared components
    //=========================
    /**
     * @description event bus for quota monitor events
     */
    const quotaMonitorBus = new events.EventBus(this, "QM-Bus", {
      eventBusName: "QuotaMonitorBus",
    });

    /**
     * @description kms construct to generate KMS-CMK with needed base policy
     */
    const kms = new KMS(this, "KMS-Hub");

    /**
     * @description slack hook url for sending quota monitor events
     */
    const ssmSlackHook = new ssm.StringParameter(this, "QM-SlackHook", {
      parameterName: map.findInMap("SSMParameters", "SlackHook"),
      stringValue: "NOP",
      description: "Slack Hook URL to send Quota Monitor events",
      simpleName: false,
    });
    Aspects.of(ssmSlackHook).add(new ConditionAspect(slackTrue));

    /**
     * @description list of targeted AWS Accounts for quota monitoring
     * value could be list Account-Ids
     */
    const ssmQMAccounts = new ssm.StringListParameter(this, "QM-Accounts", {
      parameterName: map.findInMap("SSMParameters", "Accounts"),
      stringListValue: ["NOP"],
      description: "List of target Accounts",
      simpleName: false,
    });

    /**
     * @description list of muted services and limits (quotas) for quota monitoring
     * value could be list of serviceCode[:quota_name|quota_code|resource]
     */
    const ssmNotificationMutingConfig = new ssm.StringListParameter(this, "QM-NotificationMutingConfig", {
      parameterName: map.findInMap("SSMParameters", "NotificationMutingConfig"),
      stringListValue: ["NOP"],
      description:
        "Muting configuration for services, limits e.g. ec2:L-1216C47A,ec2:Running On-Demand Standard (A, C, D, H, I, M, R, T, Z) instances,dynamodb,logs:*,geo:L-05EFD12D",
      simpleName: false,
    });

    /**
     * @description utility layer for solution microservices
     */
    const utilsLayer = new Layer(
      this,
      "QM-UtilsLayer",
      `${path.dirname(__dirname)}/../lambda/utilsLayer/dist/utilsLayer.zip`
    );

    //=========================
    // Slack workflow component
    //=========================
    /**
     * @description event rule pattern for slack events
     */
    const slackRulePattern: events.EventPattern = {
      detail: {
        status: ["WARN", "ERROR"],
      },
      detailType: [EVENT_NOTIFICATION_DETAIL_TYPE.TRUSTED_ADVISOR, EVENT_NOTIFICATION_DETAIL_TYPE.SERVICE_QUOTA],
      source: [EVENT_NOTIFICATION_SOURCES.TRUSTED_ADVISOR, EVENT_NOTIFICATION_SOURCES.SERVICE_QUOTA],
    };

    /**
     * @description policy statement allowing READ on SSM parameter store
     */
    const slackNotifierSSMReadPolicy = new iam.PolicyStatement({
      actions: ["ssm:GetParameter"],
      effect: iam.Effect.ALLOW,
      resources: [ssmSlackHook.parameterArn, ssmNotificationMutingConfig.parameterArn],
    });

    /**
     * @description construct for events-lambda
     */
    const slackNotifier = new EventsToLambda<events.EventPattern>(this, "QM-SlackNotifier", {
      assetLocation: `${path.dirname(__dirname)}/../lambda/services/slackNotifier/dist/slack-notifier.zip`,
      environment: {
        SLACK_HOOK: map.findInMap("SSMParameters", "SlackHook"),
        QM_NOTIFICATION_MUTING_CONFIG_PARAMETER: ssmNotificationMutingConfig.parameterName,
      },
      layers: [utilsLayer.layer],
      eventRule: slackRulePattern,
      eventBus: quotaMonitorBus,
      encryptionKey: kms.key,
    });
    addCfnGuardSuppression(slackNotifier.target, ["LAMBDA_INSIDE_VPC", "LAMBDA_CONCURRENCY_CHECK"]);

    slackNotifier.target.addToRolePolicy(slackNotifierSSMReadPolicy);

    // applying condition on all child nodes
    Aspects.of(slackNotifier).add(new ConditionAspect(slackTrue));

    //===========================
    // Solution helper components
    //===========================
    /**
     * @description construct to deploy lambda backed custom resource
     */
    const helper = new CustomResourceLambda(this, "QM-Helper", {
      assetLocation: `${path.dirname(__dirname)}/../lambda/services/helper/dist/helper.zip`,
      layers: [utilsLayer.layer],
      environment: {
        METRICS_ENDPOINT: map.findInMap("Metrics", "MetricsEndpoint"),
        SEND_METRIC: map.findInMap("Metrics", "SendAnonymizedData"),
        QM_STACK_ID: id,
      },
    });
    addCfnGuardSuppression(helper.function, ["LAMBDA_INSIDE_VPC", "LAMBDA_CONCURRENCY_CHECK"]);
    addCfnGuardSuppressionToNestedResources(helper, ["LAMBDA_INSIDE_VPC", "LAMBDA_CONCURRENCY_CHECK"]);

    // Custom resources
    const createUUID = helper.addCustomResource("CreateUUID");
    helper.addCustomResource("LaunchData", {
      SOLUTION_UUID: createUUID.getAttString("UUID"),
    });

    //=======================
    // SNS workflow component
    //=======================
    /**
     * @description event rule pattern for sns events
     */
    const snsRulePattern: events.EventPattern = {
      detail: {
        status: ["WARN", "ERROR"],
      },
      detailType: [EVENT_NOTIFICATION_DETAIL_TYPE.TRUSTED_ADVISOR, EVENT_NOTIFICATION_DETAIL_TYPE.SERVICE_QUOTA],
      source: [EVENT_NOTIFICATION_SOURCES.TRUSTED_ADVISOR, EVENT_NOTIFICATION_SOURCES.SERVICE_QUOTA],
    };

    /**
     * @description policy statement allowing READ on SSM parameter store
     */
    const snsPublisherSSMReadPolicy = new iam.PolicyStatement({
      actions: ["ssm:GetParameter"],
      effect: iam.Effect.ALLOW,
      resources: [ssmNotificationMutingConfig.parameterArn],
    });

    /**
     * @description construct for events-lambda
     */

    const snsPublisher = new EventsToLambdaToSNS<events.EventPattern>(this, "QM-SNSPublisher", {
      assetLocation: `${path.dirname(__dirname)}/../lambda/services/snsPublisher/dist/sns-publisher.zip`,
      environment: {
        QM_NOTIFICATION_MUTING_CONFIG_PARAMETER: ssmNotificationMutingConfig.parameterName,
        SOLUTION_UUID: createUUID.getAttString("UUID"),
        METRICS_ENDPOINT: map.findInMap("Metrics", "MetricsEndpoint"),
        SEND_METRIC: map.findInMap("Metrics", "SendAnonymizedData"),
      },
      layers: [utilsLayer.layer],
      eventRule: snsRulePattern,
      eventBus: quotaMonitorBus,
      encryptionKey: kms.key,
    });
    addCfnGuardSuppression(snsPublisher.target, ["LAMBDA_INSIDE_VPC", "LAMBDA_CONCURRENCY_CHECK"]);

    snsPublisher.target.addToRolePolicy(snsPublisherSSMReadPolicy);

    /**
     * @description subscription for email notifications for quota monitor
     */
    const qmSubscription = new Subscription(this, "QM-EmailSubscription", {
      topic: snsPublisher.snsTopic,
      protocol: sns.SubscriptionProtocol.EMAIL,
      endpoint: snsEmail.valueAsString,
    });

    // applying condition on all child nodes
    Aspects.of(qmSubscription).add(new ConditionAspect(emailTrue));

    //==============================
    // Summarizer workflow component
    //==============================
    /**
     * @description event rule pattern for summarizer sqs events
     */
    const summarizerRulePattern: events.EventPattern = {
      detail: {
        status: Fn.conditionIf(reportOKNotificationsCondition.logicalId, ["OK", "WARN", "ERROR"], ["WARN", "ERROR"]),
      },
      detailType: [EVENT_NOTIFICATION_DETAIL_TYPE.TRUSTED_ADVISOR, EVENT_NOTIFICATION_DETAIL_TYPE.SERVICE_QUOTA],
      source: [EVENT_NOTIFICATION_SOURCES.TRUSTED_ADVISOR, EVENT_NOTIFICATION_SOURCES.SERVICE_QUOTA],
    };

    /**
     * @description construct for event-sqs
     */
    const summarizerEventQueue = new EventsToSQS<events.EventPattern>(this, "QM-Summarizer-EventQueue", {
      eventRule: summarizerRulePattern,
      encryptionKey: kms.key,
      eventBus: quotaMonitorBus,
    });

    /**
     * @description quota summary dynamodb table
     */
    const summaryTable = new dynamodb.Table(this, `QM-Table`, {
      partitionKey: {
        name: "MessageId",
        type: dynamodb.AttributeType.STRING,
      },
      sortKey: {
        name: "TimeStamp",
        type: dynamodb.AttributeType.STRING,
      },
      pointInTimeRecoverySpecification: {
        pointInTimeRecoveryEnabled: true,
      },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.CUSTOMER_MANAGED,
      encryptionKey: kms.key,
      timeToLiveAttribute: "ExpiryTime",
    });
    summaryTable.addGlobalSecondaryIndex({
      indexName: "LimitCodeIndex",
      partitionKey: {
        name: "LimitCode",
        type: dynamodb.AttributeType.STRING,
      },
      sortKey: {
        name: "TimeStamp",
        type: dynamodb.AttributeType.STRING,
      },
    });

    /**
     * @description event-lambda construct for capturing quota summary
     */
    const summarizer = new EventsToLambda<events.Schedule>(this, "QM-Reporter", {
      eventRule: events.Schedule.rate(Duration.minutes(5)),
      encryptionKey: kms.key,
      assetLocation: `${path.dirname(__dirname)}/../lambda/services/reporter/dist/reporter.zip`,
      environment: {
        QUOTA_TABLE: summaryTable.tableName,
        SQS_URL: summarizerEventQueue.target.queueUrl,
        MAX_MESSAGES: "10", //100 messages can be read with each invocation, change as needed
        MAX_LOOPS: "10",
        LOG_LEVEL: LOG_LEVEL.DEBUG,
      },
      memorySize: 512,
      timeout: Duration.seconds(10),
      layers: [utilsLayer.layer],
    });
    addCfnGuardSuppression(summarizer.target, ["LAMBDA_INSIDE_VPC", "LAMBDA_CONCURRENCY_CHECK"]);

    // adding queue permissions to summarizer lambda function
    summarizer.target.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["sqs:DeleteMessage", "sqs:ReceiveMessage"],
        effect: iam.Effect.ALLOW,
        resources: [summarizerEventQueue.target.queueArn],
      })
    );

    // adding dynamodb permissions to lambda role
    summarizer.target.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["dynamodb:GetItem", "dynamodb:PutItem"],
        effect: iam.Effect.ALLOW,
        resources: [summaryTable.tableArn],
      })
    );

    //==============================
    // Deployment manager components
    //==============================
    /**
     * @description event rule pattern for SSM parameters
     */
    const ssmRulePattern: events.EventPattern = {
      detailType: ["Parameter Store Change"],
      source: ["aws.ssm"],
      resources: [ssmQMAccounts.parameterArn],
    };

    /**
     * @description construct for events-lambda
     */
    const deploymentManager = new EventsToLambda<events.EventPattern>(this, "QM-Deployment-Manager", {
      eventRule: ssmRulePattern,
      encryptionKey: kms.key,
      assetLocation: `${path.dirname(__dirname)}/../lambda/services/deploymentManager/dist/deployment-manager.zip`,
      environment: {
        EVENT_BUS_NAME: quotaMonitorBus.eventBusName,
        EVENT_BUS_ARN: quotaMonitorBus.eventBusArn,
        QM_ACCOUNT_PARAMETER: ssmQMAccounts.parameterName,
        DEPLOYMENT_MODEL: "Accounts",
      },
      layers: [utilsLayer.layer],
      memorySize: 512,
    });
    addCfnGuardSuppression(deploymentManager.target, ["LAMBDA_INSIDE_VPC", "LAMBDA_CONCURRENCY_CHECK"]);

    /**
     * @description policy statement to allow CRUD on event bus permissions
     */
    const deployerEventsPolicy1 = new iam.PolicyStatement({
      actions: ["events:PutPermission", "events:RemovePermission"],
      effect: iam.Effect.ALLOW,
      resources: ["*"], // do not support resource-level permission
    });
    const deployerEventsPolicy2 = new iam.PolicyStatement({
      actions: ["events:DescribeEventBus"],
      effect: iam.Effect.ALLOW,
      resources: [quotaMonitorBus.eventBusArn],
    });
    deploymentManager.target.addToRolePolicy(deployerEventsPolicy1);
    deploymentManager.target.addToRolePolicy(deployerEventsPolicy2);

    /**
     * @description policy statement to allow READ on SSM parameters
     */
    const helperSSMReadPolicy = new iam.PolicyStatement({
      actions: ["ssm:GetParameter"],
      effect: iam.Effect.ALLOW,
      resources: [ssmQMAccounts.parameterArn],
    });
    deploymentManager.target.addToRolePolicy(helperSSMReadPolicy);

    //==============================
    // Dashboard ETL components
    //==============================
    const enableDashboardETL = this.node.tryGetContext("ENABLE_DASHBOARD_ETL") !== "false";
    if (enableDashboardETL) {

      /**
       * @description list of limit codes to include in dashboard
       */
      const ssmDashboardLimitCodes = new ssm.StringListParameter(this, "QM-DashboardLimitCodes", {
        parameterName: map.findInMap("SSMParameters", "DashboardLimitCodes"),
        stringListValue: ["L-1216C47A", "L-0485CB21", "L-B99A9384", "L-F98FE922"],
        description: "List of LimitCodes to include in QuickSight dashboard",
        simpleName: false,
      });

      /**
       * @description S3 bucket for dashboard data
       */
      const dashboardBucket = new s3.Bucket(this, "QM-DashboardBucket", {
        encryption: s3.BucketEncryption.KMS,
        encryptionKey: kms.key,
        blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
        enforceSSL: true,
        serverAccessLogsPrefix: "access-logs/",
      });

      /**
       * @description construct for dashboard ETL lambda
       */
      const dashboardETL = new EventsToLambda<events.Schedule>(this, "QM-DashboardETL", {
        eventRule: events.Schedule.expression(dashboardETLFrequency.valueAsString),
        assetLocation: `${path.dirname(__dirname)}/../lambda/services/dashboardETL/dist/dashboard-etl.zip`,
        environment: {
          QUOTA_TABLE: summaryTable.tableName,
          DASHBOARD_BUCKET: dashboardBucket.bucketName,
          DASHBOARD_LIMIT_CODES_PARAMETER: ssmDashboardLimitCodes.parameterName,
          LOG_LEVEL: LOG_LEVEL.DEBUG,
        },
        memorySize: 512,
        timeout: Duration.minutes(5),
        layers: [utilsLayer.layer],
      });
      addCfnGuardSuppression(dashboardETL.target, ["LAMBDA_INSIDE_VPC", "LAMBDA_CONCURRENCY_CHECK"]);

      // adding dynamodb permissions to dashboard ETL lambda
      dashboardETL.target.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ["dynamodb:Scan", "dynamodb:Query"],
          effect: iam.Effect.ALLOW,
          resources: [summaryTable.tableArn, `${summaryTable.tableArn}/index/*`],
        })
      );

      // adding S3 permissions to dashboard ETL lambda
      dashboardETL.target.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ["s3:PutObject", "s3:PutObjectAcl"],
          effect: iam.Effect.ALLOW,
          resources: [`${dashboardBucket.bucketArn}/*`],
        })
      );

      // adding SSM permissions to dashboard ETL lambda
      dashboardETL.target.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ["ssm:GetParameter"],
          effect: iam.Effect.ALLOW,
          resources: [ssmDashboardLimitCodes.parameterArn],
        })
      );

      // adding KMS permissions to dashboard ETL lambda
      dashboardETL.target.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ["kms:Decrypt", "kms:Encrypt", "kms:GenerateDataKey"],
          effect: iam.Effect.ALLOW,
          resources: [kms.key.keyArn],
        })
      );

      /**
       * @description Bucket policy to allow QuickSight access
       */
      dashboardBucket.addToResourcePolicy(
        new iam.PolicyStatement({
          sid: "QuickSightAccess",
          effect: iam.Effect.ALLOW,
          principals: [
            new iam.ServicePrincipal("quicksight.amazonaws.com"),
            new iam.ArnPrincipal(`arn:aws:iam::${this.account}:role/service-role/aws-quicksight-service-role-v0`)
          ],
          actions: ["s3:GetObject", "s3:ListBucket", "s3:GetBucketLocation"],
          resources: [dashboardBucket.bucketArn, `${dashboardBucket.bucketArn}/*`],
          // conditions: {
          //   StringEquals: {
          //     "aws:SourceAccount": this.account
          //   }
          // }
        })
      );

      /**
       * @description KMS key policy to allow QuickSight decrypt
       */
      kms.key.addToResourcePolicy(
        new iam.PolicyStatement({
          sid: "QuickSightKMSAccess",
          effect: iam.Effect.ALLOW,
          principals: [
            new iam.ServicePrincipal("quicksight.amazonaws.com"),
            new iam.ArnPrincipal(`arn:aws:iam::${this.account}:role/service-role/aws-quicksight-service-role-v0`)
          ],
          actions: ["kms:Decrypt", "kms:GenerateDataKey"],
          resources: ["*"],
          // conditions: {
          //   StringEquals: {
          //     "aws:SourceAccount": this.account
          //   }
          // }
        })
      );

      new CfnOutput(this, "DashboardBucket", {
        value: dashboardBucket.bucketName,
        description: "S3 bucket containing dashboard data for QuickSight",
      });

      new CfnOutput(this, "DashboardLimitCodesParameter", {
        value: ssmDashboardLimitCodes.parameterName,
        description: "SSM parameter for dashboard limit codes list",
      });

    } // end enableDashboardETL

    /**
     * used to check whether trusted advisor is available (have the support plan needed) in the account
     */
    const taDescribeTrustedAdvisorChecksPolicy = new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ["support:DescribeTrustedAdvisorChecks"],
      resources: ["*"], // does not allow resource-level permissions
    });
    deploymentManager.target.addToRolePolicy(taDescribeTrustedAdvisorChecksPolicy);

    //==============================
    // Grafana integration
    //
    // Provisions Amazon Managed Grafana with Athena as the data source to query
    // the DynamoDB summary table directly. The flow is:
    //   Grafana → Athena (SQL) → DynamoDB connector Lambda → DynamoDB table
    //
    // Controlled by CDK context flag: -c ENABLE_GRAFANA=true
    //==============================
    const enableGrafana = this.node.tryGetContext("ENABLE_GRAFANA") === "true";
    if (enableGrafana) {

      /**
       * @description S3 bucket used as scratch space by Athena.
       * Athena requires an S3 location to write query results and the DynamoDB
       * connector uses it as a spill bucket for large intermediate results.
       * A 7-day lifecycle rule auto-cleans temporary files.
       */
      const athenaResultsBucket = new s3.Bucket(this, "QM-AthenaResultsBucket", {
        encryption: s3.BucketEncryption.S3_MANAGED,
        blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
        enforceSSL: true,
        lifecycleRules: [{ expiration: Duration.days(7) }],
      });
      NagSuppressions.addResourceSuppressions(athenaResultsBucket, [
        {
          id: "AwsSolutions-S1",
          reason: "Temporary scratch bucket for Athena query results with 7-day auto-expiry. Access logging not needed.",
        },
      ]);

      /**
       * @description Dedicated Athena workgroup for Grafana queries.
       * Isolates Quota Monitor queries from other Athena usage in the account
       * and enforces the output location so results always go to our bucket.
       */
      new athena.CfnWorkGroup(this, "QM-AthenaWorkgroup", {
        name: "QuotaMonitorGrafana",
        description: "Athena workgroup for Quota Monitor Grafana dashboard",
        state: "ENABLED",
        workGroupConfiguration: {
          resultConfiguration: {
            outputLocation: `s3://${athenaResultsBucket.bucketName}/results/`,
          },
          enforceWorkGroupConfiguration: true,
        },
      });

      /**
       * @description Pre-built Athena DynamoDB connector from the AWS Serverless Application Repository.
       * Deploys a Lambda function that translates Athena SQL queries into DynamoDB
       * scan/query operations. The applicationId points to us-east-1 because that's
       * where AWS publishes the SAR application — the Lambda itself deploys in the
       * current region.
       */
      const athenaDdbConnector = new sam.CfnApplication(this, "QM-AthenaDDBConnector", {
        location: {
          applicationId: "arn:aws:serverlessrepo:us-east-1:292517598671:applications/AthenaDynamoDBConnector",
          semanticVersion: "2026.13.1",
        },
        parameters: {
          AthenaCatalogName: "quota-monitor-ddb",
          SpillBucket: athenaResultsBucket.bucketName,
        },
      });

      /**
       * @description Athena data catalog that registers the DynamoDB connector.
       * This is the entry point for Athena to discover DynamoDB tables.
       * In SQL queries, use: SELECT * FROM "quota-monitor-ddb"."default"."table_name"
       * Must be created after the connector Lambda is deployed.
       */
      const athenaCatalog = new athena.CfnDataCatalog(this, "QM-AthenaCatalog", {
        name: "quota-monitor-ddb",
        type: "LAMBDA",
        description: "Athena catalog for Quota Monitor DynamoDB tables",
        parameters: {
          function: `arn:aws:lambda:${this.region}:${this.account}:function:quota-monitor-ddb`,
        },
      });
      athenaCatalog.addDependency(athenaDdbConnector);

      /**
       * @description Grant the DynamoDB connector Lambda KMS decrypt permission.
       * The DynamoDB summary table is encrypted with a customer-managed KMS key.
       * The connector Lambda (deployed via SAR) needs kms:Decrypt to read the table.
       * Since the connector is in a nested stack with an auto-generated role name,
       * we grant access via the KMS key resource policy using a condition that
       * matches the connector's role name pattern. A KMS key resource policy grant
       * works independently of the caller's IAM identity policy.
       */
      kms.key.addToResourcePolicy(
        new iam.PolicyStatement({
          sid: "AllowAthenaDDBConnectorDecrypt",
          effect: iam.Effect.ALLOW,
          principals: [new iam.AnyPrincipal()],
          actions: ["kms:Decrypt"],
          resources: ["*"],
          conditions: {
            "StringLike": {
              "aws:PrincipalArn": `arn:aws:iam::${this.account}:role/*AthenaDDBCon*`,
            },
          },
        })
      );

      /**
       * @description IAM role assumed by the Managed Grafana workspace.
       * Grants permissions for the full query chain:
       *   Grafana → Athena → Glue catalog → DynamoDB connector Lambda → DynamoDB + KMS
       * Also grants S3 access for Athena to write/read query results.
       */
      const grafanaRole = new iam.Role(this, "QM-GrafanaRole", {
        assumedBy: new iam.ServicePrincipal("grafana.amazonaws.com"),
        description: "IAM role for Amazon Managed Grafana workspace",
      });

      // Athena permissions: run queries, list catalogs/databases/tables
      grafanaRole.addToPolicy(
        new iam.PolicyStatement({
          actions: [
            "athena:GetQueryExecution",
            "athena:GetQueryResults",
            "athena:StartQueryExecution",
            "athena:StopQueryExecution",
          ],
          effect: iam.Effect.ALLOW,
          resources: [
            `arn:aws:athena:${this.region}:${this.account}:workgroup/QuotaMonitorGrafana`,
          ],
        })
      );
      grafanaRole.addToPolicy(
        new iam.PolicyStatement({
          actions: [
            "athena:ListWorkGroups",
            "athena:GetWorkGroup",
            "athena:ListDataCatalogs",
            "athena:GetDataCatalog",
            "athena:ListDatabases",
            "athena:GetDatabase",
            "athena:ListTableMetadata",
            "athena:GetTableMetadata",
          ],
          effect: iam.Effect.ALLOW,
          resources: ["*"],
        })
      );

      // S3 permissions: Athena writes query results and reads them back
      grafanaRole.addToPolicy(
        new iam.PolicyStatement({
          actions: ["s3:GetObject", "s3:PutObject", "s3:ListBucket", "s3:GetBucketLocation"],
          effect: iam.Effect.ALLOW,
          resources: [athenaResultsBucket.bucketArn, `${athenaResultsBucket.bucketArn}/*`],
        })
      );

      // Glue permissions: Athena uses Glue Data Catalog for table metadata discovery
      grafanaRole.addToPolicy(
        new iam.PolicyStatement({
          actions: [
            "glue:GetDatabase",
            "glue:GetDatabases",
            "glue:GetTable",
            "glue:GetTables",
            "glue:GetPartitions",
          ],
          effect: iam.Effect.ALLOW,
          resources: ["*"],
        })
      );

      // Lambda permissions: invoke the DynamoDB connector that Athena calls to read DynamoDB
      grafanaRole.addToPolicy(
        new iam.PolicyStatement({
          actions: ["lambda:InvokeFunction"],
          effect: iam.Effect.ALLOW,
          resources: [`arn:aws:lambda:${this.region}:${this.account}:function:quota-monitor-ddb`],
        })
      );

      // DynamoDB permissions: the connector reads the summary table and its indexes
      grafanaRole.addToPolicy(
        new iam.PolicyStatement({
          actions: ["dynamodb:Scan", "dynamodb:Query", "dynamodb:DescribeTable"],
          effect: iam.Effect.ALLOW,
          resources: [summaryTable.tableArn, `${summaryTable.tableArn}/index/*`],
        })
      );

      // KMS permissions: decrypt the customer-managed key used to encrypt the DynamoDB table
      grafanaRole.addToPolicy(
        new iam.PolicyStatement({
          actions: ["kms:Decrypt"],
          effect: iam.Effect.ALLOW,
          resources: [kms.key.keyArn],
        })
      );

      /**
       * @description Amazon Managed Grafana workspace with SSO authentication.
       * Users access the dashboard via the workspace URL and log in through
       * AWS IAM Identity Center. The workspace uses the grafanaRole to make
       * all AWS API calls (Athena, S3, DynamoDB, etc.).
       */
      const grafanaWorkspace = new grafana.CfnWorkspace(this, "QM-GrafanaWorkspace", {
        accountAccessType: "CURRENT_ACCOUNT",
        authenticationProviders: ["AWS_SSO"],
        permissionType: "SERVICE_MANAGED",
        name: "QuotaMonitorDashboard",
        description: "Grafana workspace for Quota Monitor dashboard",
        roleArn: grafanaRole.roleArn,
        dataSources: ["ATHENA"],
      });

      // cdk-nag suppressions
      NagSuppressions.addResourceSuppressions(
        grafanaRole,
        [
          {
            id: "AwsSolutions-IAM5",
            reason: "Glue catalog actions do not support resource-level permissions. S3 and Athena resources are scoped.",
          },
        ],
        true
      );

      new CfnOutput(this, "GrafanaWorkspaceUrl", {
        value: `https://${grafanaWorkspace.attrEndpoint}`,
        description: "Amazon Managed Grafana workspace URL",
      });

      new CfnOutput(this, "AthenaWorkgroup", {
        value: "QuotaMonitorGrafana",
        description: "Athena workgroup for Grafana queries",
      });

      new CfnOutput(this, "AthenaCatalog", {
        value: "quota-monitor-ddb",
        description: "Athena data catalog for DynamoDB",
      });

    } // end enableGrafana

    //=============================================================================================
    // Outputs
    //=============================================================================================
    new CfnOutput(this, "SlackHookKey", {
      condition: slackTrue,
      value: map.findInMap("SSMParameters", "SlackHook"),
      description: "SSM parameter for Slack Web Hook, change the value for your slack workspace",
    });

    new CfnOutput(this, "UUID", {
      value: createUUID.getAttString("UUID"),
      description: "UUID for the deployment",
    });

    new CfnOutput(this, "EventBus", {
      value: quotaMonitorBus.eventBusArn,
      description: "Event Bus Arn in hub",
    });

    new CfnOutput(this, "SNSTopic", {
      value: snsPublisher.snsTopic.topicArn,
      description: "The SNS Topic where notifications are published to",
    });
  }
}
