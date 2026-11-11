"""Upload an ARM64 Python code bundle and create or update a Runtime.

Build the zip as documented in README first. Caller supplies its own bucket,
execution role and AWS credentials. No credentials or account IDs are stored.
"""
import argparse
import boto3

parser = argparse.ArgumentParser()
parser.add_argument('--bundle', required=True)
parser.add_argument('--bucket', required=True)
parser.add_argument('--role-arn', required=True)
parser.add_argument('--region', default='ap-northeast-1')
parser.add_argument('--name', default='vehicle_voice_sonic_bidi')
parser.add_argument('--runtime-id', help='Update an existing runtime instead of creating one')
args = parser.parse_args()
session = boto3.Session(region_name=args.region)
key = f'{args.name}/strands-bidi.zip'
session.client('s3').upload_file(args.bundle, args.bucket, key)
configuration = dict(
    agentRuntimeArtifact={'codeConfiguration': {'code': {'s3': {'bucket': args.bucket, 'prefix': key}},
        'runtime': 'PYTHON_3_12', 'entryPoint': ['main.py']}},
    roleArn=args.role_arn, networkConfiguration={'networkMode': 'PUBLIC'},
    environmentVariables={'HOST': '0.0.0.0', 'SONIC_REGION': args.region,
                          'SONIC_MODEL': 'amazon.nova-2-5-sonic'},
)
client = session.client('bedrock-agentcore-control')
if args.runtime_id:
    response = client.update_agent_runtime(agentRuntimeId=args.runtime_id, **configuration)
else:
    response = client.create_agent_runtime(agentRuntimeName=args.name, **configuration)
print('Runtime:', response['agentRuntimeArn'], 'status:', response['status'])
