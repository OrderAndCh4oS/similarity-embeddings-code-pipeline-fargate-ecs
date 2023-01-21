import * as cdk from 'aws-cdk-lib';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ecs_patterns from 'aws-cdk-lib/aws-ecs-patterns';
import * as codebuild from 'aws-cdk-lib/aws-codebuild';
import * as codepipeline from 'aws-cdk-lib/aws-codepipeline';
import * as codepipeline_actions from 'aws-cdk-lib/aws-codepipeline-actions';
import { Construct } from 'constructs';

export class EcsCodeDeployExampleStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const githubUserName = new cdk.CfnParameter(this, "githubUserName", {
      type: "String",
      description: "Github username for source code repository"
    })

    const githubRepository = new cdk.CfnParameter(this, "githubRepository", {
      type: "String",
      description: "Github source code repository",
      default: "amazon-ecs-fargate-cdk-v2-cicd"
    })

    const githubPersonalTokenSecretName = new cdk.CfnParameter(this, "githubPersonalTokenSecretName", {
      type: "String",
      description: "The name of the AWS Secrets Manager Secret which holds the GitHub Personal Access Token for this project.",
      default: "/aws-samples/amazon-ecs-fargate-cdk-v2-cicd/github/personal_access_token"
    })

    const ecrRepo = new ecr.Repository(this, 'ecrRepo');

    const vpc = new ec2.Vpc(this, `${this.stackName}Vpc`, {
      natGateways: 1,
      maxAzs: 3  /* does a sample need 3 az's? */
    });

    // const clusterAdmin = new iam.Role(this, 'adminrole', {
    //   assumedBy: new iam.AccountRootPrincipal()
    // });

    const cluster = new ecs.Cluster(this, `${this.stackName}Cluster`, {
      vpc: vpc,
    });

    const logging = new ecs.AwsLogDriver({
      streamPrefix: "ecs-logs"
    });

    const taskRole = new iam.Role(this, `${this.stackName}TaskRole`, {
      roleName: `ecs-taskrole-${this.stackName}`,
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com')
    });

    const executionRolePolicy =  new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      resources: ['*'],
      actions: [
        "ecr:getauthorizationtoken",
        "ecr:batchchecklayeravailability",
        "ecr:getdownloadurlforlayer",
        "ecr:batchgetimage",
        "logs:createlogstream",
        "logs:putlogevents"
      ]
    });

    const taskDef = new ecs.FargateTaskDefinition(this, `${this.stackName}TaskDef`, {
      taskRole: taskRole
    });

    taskDef.addToExecutionRolePolicy(executionRolePolicy);

    const baseImage = 'public.ecr.aws/amazonlinux/amazonlinux:2022'
    const container = taskDef.addContainer(`${this.stackName}AppContainer`, {
      image: ecs.ContainerImage.fromRegistry(baseImage),
      memoryLimitMiB: 256,
      cpu: 256,
      logging
    });

    container.addPortMappings({
      containerPort: 5000,
      protocol: ecs.Protocol.TCP
    });

    const fargateService = new ecs_patterns.ApplicationLoadBalancedFargateService(this, `${this.stackName}FargateService`, {
      cluster: cluster,
      taskDefinition: taskDef,
      publicLoadBalancer: true,
      desiredCount: 1,
      listenerPort: 80
    });

    // const scaling = fargateService.service.autoScaleTaskCount({ maxCapacity: 6 });
    // scaling.scaleOnCpuUtilization('cpuscaling', {
    //   targetUtilizationPercent: 10,
    //   scaleInCooldown: cdk.Duration.seconds(60),
    //   scaleOutCooldown: cdk.Duration.seconds(60)
    // });

    const gitHubSource = codebuild.Source.gitHub({
      owner: githubUserName.valueAsString,
      repo: githubRepository.valueAsString,
      webhook: true,
      webhookFilters: [
        codebuild.FilterGroup
            .inEventOf(codebuild.EventAction.PUSH)
            .andBranchIs('main'),
      ],
    });

    const project = new codebuild.Project(this, `${this.stackName}CodeBuild`, {
      projectName: `${this.stackName}`,
      source: gitHubSource,
      environment: {
        buildImage: codebuild.LinuxBuildImage.AMAZON_LINUX_2_4,
        privileged: true
      },
      environmentVariables: {
        'cluster_name': {
          value: `${cluster.clusterName}`
        },
        'ecr_repo_uri': {
          value: `${ecrRepo.repositoryUri}`
        }
      },
      badge: true,
      buildSpec: codebuild.BuildSpec.fromObject({
        version: "0.2",
        phases: {
          pre_build: {
            /*
            commands: [
              'env',
              'export tag=${CODEBUILD_RESOLVED_SOURCE_VERSION}'
            ]
            */
            commands: [
              'env',
              'export tag=latest'
            ]
          },
          build: {
            commands: [
              'cd src',
              `docker build -t $ecr_repo_uri:$tag .`,
              '$(aws ecr get-login --no-include-email)',
              'docker push $ecr_repo_uri:$tag'
            ]
          },
          post_build: {
            commands: [
              'echo "in post-build stage"',
              'cd ..',
              "printf '[{\"name\":\"similarity-embeddings-app\",\"imageUri\":\"%s\"}]' $ecr_repo_uri:$tag > imagedefinitions.json",
              "pwd; ls -al; cat imagedefinitions.json"
            ]
          }
        },
        artifacts: {
          files: [
            'imagedefinitions.json'
          ]
        }
      })
    });

    const sourceOutput = new codepipeline.Artifact();
    const buildOutput = new codepipeline.Artifact();
    const nameOfGithubPersonTokenParameterAsString = githubPersonalTokenSecretName.valueAsString
    const sourceAction = new codepipeline_actions.GitHubSourceAction({
      actionName: 'github_source',
      owner: githubUserName.valueAsString,
      repo: githubRepository.valueAsString,
      branch: 'main',
      oauthToken: cdk.SecretValue.secretsManager(nameOfGithubPersonTokenParameterAsString),
      output: sourceOutput
    });

    const buildAction = new codepipeline_actions.CodeBuildAction({
      actionName: 'codebuild',
      project: project,
      input: sourceOutput,
      outputs: [buildOutput],
    });

    const manualApprovalAction = new codepipeline_actions.ManualApprovalAction({
      actionName: 'approve',
    });

    const deployAction = new codepipeline_actions.EcsDeployAction({
      actionName: 'deployAction',
      service: fargateService.service,
      imageFile: new codepipeline.ArtifactPath(buildOutput, `imagedefinitions.json`)
    });

    new codepipeline.Pipeline(this, `${this.stackName}CodePipeline`, {
      stages: [
        {
          stageName: 'source',
          actions: [sourceAction],
        },
        {
          stageName: 'build',
          actions: [buildAction],
        },
        {
          stageName: 'approve',
          actions: [manualApprovalAction],
        },
        {
          stageName: 'deploy-to-ecs',
          actions: [deployAction],
        }
      ]
    });

    ecrRepo.grantPullPush(project.role!)
    project.addToRolePolicy(new iam.PolicyStatement({
      actions: [
        "ecs:describecluster",
        "ecr:getauthorizationtoken",
        "ecr:batchchecklayeravailability",
        "ecr:batchgetimage",
        "ecr:getdownloadurlforlayer"
      ],
      resources: [`${cluster.clusterArn}`],
    }));

    new cdk.CfnOutput(this, `${this.stackName}Image`, { value: ecrRepo.repositoryUri+":latest"} )
    new cdk.CfnOutput(this, `${this.stackName}LoadBalancerDns`, { value: fargateService.loadBalancer.loadBalancerDnsName });
  }
}