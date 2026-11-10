#!/usr/bin/env bash
#
# Deploy Lost N Found to Amazon ECS Express Mode.
#
# Express Mode is AWS's recommended replacement for App Runner (closed to new
# customers since 30 April 2026). One call provisions Fargate, an internet-facing
# Application Load Balancer, HTTPS, CloudWatch logs and autoscaling.
#
# Prerequisites (see deploy/aws/README.md):
#   * an RDS Postgres database with deploy/aws/rds-schema.sql applied
#   * an AWS CLI profile with ECR, ECS, IAM, S3 and Secrets Manager access
#
# Usage:
#   cp deploy/aws/.env.aws.example deploy/aws/.env.aws
#   $EDITOR deploy/aws/.env.aws
#   bash deploy/aws/deploy.sh
#
# Re-running rebuilds the image and rolls the service to the new revision.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
ENV_FILE="${ENV_FILE:-$SCRIPT_DIR/.env.aws}"
SERVICE_ARN_FILE="$SCRIPT_DIR/.service-arn"

log() { printf '\n==> %s\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

[[ -f "$ENV_FILE" ]] || die "Missing $ENV_FILE. Copy deploy/aws/.env.aws.example to deploy/aws/.env.aws and fill it in."
log "Loading $ENV_FILE"
# Drop ambient values so only the deploy env file configures the container.
unset NODE_ENV PORT HOST GOOGLE_ALLOWED_DOMAIN GOOGLE_CLIENT_ID GOOGLE_CLIENT_SECRET \
  APP_ORIGIN SESSION_SECRET RDS_DATABASE_URL RDS_TABLE_PREFIX S3_BUCKET S3_REGION CAMPUS_NAME
set -a
# Strip CRLF so a file edited on Windows still produces clean values.
# shellcheck disable=SC1090
source <(sed 's/\r$//' "$ENV_FILE")
set +a

command -v aws >/dev/null 2>&1 || die "AWS CLI v2 is required: https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html"
command -v docker >/dev/null 2>&1 || die "Docker is required to build and push the image."
command -v node >/dev/null 2>&1 || die "Node.js is required to build the request JSON."

AWS_REGION="${AWS_REGION:-us-east-1}"
export AWS_REGION
export AWS_DEFAULT_REGION="$AWS_REGION"

SERVICE_NAME="${SERVICE_NAME:-lost-n-found}"
ECR_REPOSITORY="${ECR_REPOSITORY:-lost-n-found}"
CLUSTER="${CLUSTER:-default}"
CONTAINER_PORT="${CONTAINER_PORT:-3000}"
CPU="${CPU:-512}"          # task CPU units: 256 = 0.25 vCPU
MEMORY="${MEMORY:-1024}"   # task memory in MiB
MIN_TASKS="${MIN_TASKS:-1}"
MAX_TASKS="${MAX_TASKS:-1}"
EXEC_ROLE="${EXEC_ROLE:-ecsTaskExecutionRole}"
INFRA_ROLE="${INFRA_ROLE:-ecsInfrastructureRoleForExpressServices}"
TASK_ROLE="${TASK_ROLE:-lnfTaskRole}"
SECRET_NAME="${SECRET_NAME:-$SERVICE_NAME/app}"
SECRET_VARS="${SECRET_VARS:-RDS_DATABASE_URL SESSION_SECRET GOOGLE_CLIENT_SECRET}"
RDS_TABLE_PREFIX="${RDS_TABLE_PREFIX:-lnf_}"
S3_REGION="${S3_REGION:-$AWS_REGION}"
IMAGE_TAG="${IMAGE_TAG:-$(date -u +%Y%m%d%H%M%S)}"
export CONTAINER_PORT SECRET_NAME SECRET_VARS RDS_TABLE_PREFIX S3_REGION

# The app listens on PORT; the ALB forwards CONTAINER_PORT. Keep them aligned.
PORT="${PORT:-$CONTAINER_PORT}"
export PORT
[[ "$PORT" == "$CONTAINER_PORT" ]] || die "PORT ($PORT) must match CONTAINER_PORT ($CONTAINER_PORT), otherwise the load balancer cannot reach the container."

[[ -n "${SESSION_SECRET:-}" ]] || die "Set SESSION_SECRET in $ENV_FILE. Generate one with: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\""
[[ -n "${GOOGLE_CLIENT_ID:-}" ]] || printf 'warning: GOOGLE_CLIENT_ID is empty, so Google sign-in will be disabled.\n'
[[ -n "${RDS_DATABASE_URL:-}" ]] || printf 'warning: RDS_DATABASE_URL is empty. The app will fall back to the container filesystem and lose data on every restart or deploy.\n'

ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
REGISTRY="$ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com"
S3_BUCKET="${S3_BUCKET:-lnf-photos-$ACCOUNT_ID}"
export S3_BUCKET

# ---------------------------------------------------------------- container ---

if ! aws ecr describe-repositories --repository-names "$ECR_REPOSITORY" >/dev/null 2>&1; then
  log "Creating ECR repository $ECR_REPOSITORY"
  aws ecr create-repository \
    --repository-name "$ECR_REPOSITORY" \
    --image-scanning-configuration scanOnPush=true >/dev/null
fi

IMAGE_URI="$REGISTRY/$ECR_REPOSITORY:$IMAGE_TAG"
export IMAGE_URI

log "Building image $IMAGE_URI"
aws ecr get-login-password | docker login --username AWS --password-stdin "$REGISTRY" >/dev/null
docker build --platform linux/amd64 -t "$IMAGE_URI" "$ROOT_DIR"

log "Pushing image"
docker push "$IMAGE_URI" >/dev/null
docker tag "$IMAGE_URI" "$REGISTRY/$ECR_REPOSITORY:latest"
docker push "$REGISTRY/$ECR_REPOSITORY:latest" >/dev/null

# --------------------------------------------------------------------- iam ---

create_role() {
  local name="$1" trust="$2"
  if aws iam get-role --role-name "$name" >/dev/null 2>&1; then
    log "IAM role $name already exists"
    return
  fi
  log "Creating IAM role $name"
  aws iam create-role --role-name "$name" --assume-role-policy-document "$trust" >/dev/null
}

EXEC_TRUST='{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"ecs-tasks.amazonaws.com"},"Action":"sts:AssumeRole"}]}'
INFRA_TRUST='{"Version":"2012-10-17","Statement":[{"Sid":"AllowAccessInfrastructureForECSExpressServices","Effect":"Allow","Principal":{"Service":"ecs.amazonaws.com"},"Action":"sts:AssumeRole"}]}'

create_role "$EXEC_ROLE" "$EXEC_TRUST"
create_role "$INFRA_ROLE" "$INFRA_TRUST"
create_role "$TASK_ROLE" "$EXEC_TRUST"

aws iam attach-role-policy \
  --role-name "$EXEC_ROLE" \
  --policy-arn arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy
aws iam attach-role-policy \
  --role-name "$INFRA_ROLE" \
  --policy-arn arn:aws:iam::aws:policy/service-role/AmazonECSInfrastructureRoleforExpressGatewayServices

EXEC_ROLE_ARN="arn:aws:iam::$ACCOUNT_ID:role/$EXEC_ROLE"
INFRA_ROLE_ARN="arn:aws:iam::$ACCOUNT_ID:role/$INFRA_ROLE"
TASK_ROLE_ARN="arn:aws:iam::$ACCOUNT_ID:role/$TASK_ROLE"

# ---------------------------------------------------------------------- s3 ---

if ! aws s3api head-bucket --bucket "$S3_BUCKET" >/dev/null 2>&1; then
  log "Creating S3 bucket $S3_BUCKET"
  if [[ "$AWS_REGION" == "us-east-1" ]]; then
    aws s3api create-bucket --bucket "$S3_BUCKET" >/dev/null
  else
    aws s3api create-bucket --bucket "$S3_BUCKET" \
      --create-bucket-configuration "LocationConstraint=$AWS_REGION" >/dev/null
  fi
fi

# Photos are served from plain object URLs, so objects must be publicly readable.
# The bucket stays private for listing/writes; only GetObject is opened up.
log "Allowing public reads of photos in $S3_BUCKET"
aws s3api put-public-access-block --bucket "$S3_BUCKET" \
  --public-access-block-configuration \
  "BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=false,RestrictPublicBuckets=false"

BUCKET_POLICY="$(node -e '
  process.stdout.write(JSON.stringify({
    Version: "2012-10-17",
    Statement: [{
      Sid: "PublicReadPhotos",
      Effect: "Allow",
      Principal: "*",
      Action: ["s3:GetObject"],
      Resource: "arn:aws:s3:::" + process.env.S3_BUCKET + "/*",
    }],
  }));
')"
aws s3api put-bucket-policy --bucket "$S3_BUCKET" --policy "$BUCKET_POLICY"

TASK_S3_POLICY="$(node -e '
  process.stdout.write(JSON.stringify({
    Version: "2012-10-17",
    Statement: [{
      Effect: "Allow",
      Action: ["s3:PutObject", "s3:GetObject"],
      Resource: "arn:aws:s3:::" + process.env.S3_BUCKET + "/*",
    }],
  }));
')"
aws iam put-role-policy \
  --role-name "$TASK_ROLE" \
  --policy-name "${SERVICE_NAME}-s3" \
  --policy-document "$TASK_S3_POLICY"

# ----------------------------------------------------------------- secrets ---

SECRET_ARN=""
SECRETS_JSON="$(node -e '
  const names = String(process.env.SECRET_VARS || "").split(/\s+/).filter(Boolean);
  const out = {};
  for (const name of names) if (process.env[name]) out[name] = process.env[name];
  process.stdout.write(JSON.stringify(out));
')"

if [[ "$SECRETS_JSON" != "{}" ]]; then
  log "Storing application secrets in Secrets Manager ($SECRET_NAME)"
  if aws secretsmanager describe-secret --secret-id "$SECRET_NAME" >/dev/null 2>&1; then
    aws secretsmanager put-secret-value --secret-id "$SECRET_NAME" --secret-string "$SECRETS_JSON" >/dev/null
    SECRET_ARN="$(aws secretsmanager describe-secret --secret-id "$SECRET_NAME" --query ARN --output text)"
  else
    SECRET_ARN="$(aws secretsmanager create-secret --name "$SECRET_NAME" --secret-string "$SECRETS_JSON" --query ARN --output text)"
  fi
  export SECRET_ARN

  # The managed execution policy covers ECR and CloudWatch Logs only.
  POLICY_DOC="$(node -e '
    process.stdout.write(JSON.stringify({
      Version: "2012-10-17",
      Statement: [{ Effect: "Allow", Action: ["secretsmanager:GetSecretValue"], Resource: process.env.SECRET_ARN }],
    }));
  ')"
  aws iam put-role-policy \
    --role-name "$EXEC_ROLE" \
    --policy-name "${SERVICE_NAME}-read-secrets" \
    --policy-document "$POLICY_DOC"
fi

# ----------------------------------------------------------- service config ---

PRIMARY_CONTAINER_JSON="$(node -e '
  const names = [
    "NODE_ENV", "PORT", "HOST", "GOOGLE_CLIENT_ID", "GOOGLE_ALLOWED_DOMAIN",
    "APP_ORIGIN", "RDS_TABLE_PREFIX", "S3_BUCKET", "S3_REGION", "CAMPUS_NAME",
  ];
  const environment = names
    .filter((name) => process.env[name] && process.env[name].trim())
    .map((name) => ({ name, value: process.env[name] }));

  const primary = {
    image: process.env.IMAGE_URI,
    containerPort: Number(process.env.CONTAINER_PORT),
  };
  if (environment.length) primary.environment = environment;

  const secretNames = String(process.env.SECRET_VARS || "").split(/\s+/).filter(Boolean);
  const secretArn = process.env.SECRET_ARN || "";
  if (secretArn) {
    const secrets = secretNames
      .filter((name) => process.env[name])
      .map((name) => ({ name, valueFrom: secretArn + ":" + name + "::" }));
    if (secrets.length) primary.secrets = secrets;
  }
  process.stdout.write(JSON.stringify(primary));
')"

SCALING_TARGET="{\"minTaskCount\":$MIN_TASKS,\"maxTaskCount\":$MAX_TASKS}"

SERVICE_ARN="${SERVICE_ARN:-}"
if [[ -z "$SERVICE_ARN" && -f "$SERVICE_ARN_FILE" ]]; then
  SERVICE_ARN="$(cat "$SERVICE_ARN_FILE")"
fi

if [[ -n "$SERVICE_ARN" ]]; then
  log "Updating Express Mode service $SERVICE_NAME"
  aws ecs update-express-gateway-service \
    --service-arn "$SERVICE_ARN" \
    --primary-container "$PRIMARY_CONTAINER_JSON" \
    --execution-role-arn "$EXEC_ROLE_ARN" \
    --task-role-arn "$TASK_ROLE_ARN" \
    --health-check-path "/health" \
    --cpu "$CPU" \
    --memory "$MEMORY" \
    --scaling-target "$SCALING_TARGET" >/dev/null
else
  log "Creating Express Mode service $SERVICE_NAME"
  SERVICE_ARN="$(aws ecs create-express-gateway-service \
    --service-name "$SERVICE_NAME" \
    --cluster "$CLUSTER" \
    --primary-container "$PRIMARY_CONTAINER_JSON" \
    --execution-role-arn "$EXEC_ROLE_ARN" \
    --infrastructure-role-arn "$INFRA_ROLE_ARN" \
    --task-role-arn "$TASK_ROLE_ARN" \
    --health-check-path "/health" \
    --cpu "$CPU" \
    --memory "$MEMORY" \
    --scaling-target "$SCALING_TARGET" \
    --query 'service.serviceArn' --output text)"
  printf '%s\n' "$SERVICE_ARN" >"$SERVICE_ARN_FILE"
fi

# ---------------------------------------------------------------- wait + url ---

log "Waiting for the service to become ACTIVE (usually a few minutes)"
STATUS=""
for _ in $(seq 1 80); do
  STATUS="$(aws ecs describe-express-gateway-service --service-arn "$SERVICE_ARN" \
    --query 'service.status.statusCode' --output text 2>/dev/null || printf 'UNKNOWN')"
  [[ "$STATUS" == "ACTIVE" ]] && break
  sleep 15
done
[[ "$STATUS" == "ACTIVE" ]] || die "Service did not reach ACTIVE (last status: $STATUS). Inspect it with: aws ecs describe-express-gateway-service --service-arn $SERVICE_ARN"

SERVICE_URL=""
for _ in $(seq 1 20); do
  SERVICE_URL="$(aws ecs describe-express-gateway-service --service-arn "$SERVICE_ARN" \
    --query 'service.ingressPaths[0].endpoint' --output text 2>/dev/null || true)"
  [[ "$SERVICE_URL" == http* ]] && break
  sleep 10
done
[[ "$SERVICE_URL" == http* ]] || die "Service is ACTIVE but has no public endpoint yet. Check the ECS console."

printf '\nService URL: %s\n' "$SERVICE_URL"
printf 'Health:      %s/health\n' "$SERVICE_URL"
printf 'Google redirect URI: %s/api/auth/google/callback\n' "$SERVICE_URL"

log "Checking the health endpoint"
HEALTHY=false
for _ in $(seq 1 12); do
  if curl -fsS --max-time 10 "$SERVICE_URL/health" >/dev/null 2>&1; then
    HEALTHY=true
    break
  fi
  sleep 10
done
if [[ "$HEALTHY" == true ]]; then
  printf 'Health check passed.\n'
else
  printf 'warning: /health did not answer yet. The first deployment can take another minute; check the ECS console and CloudWatch logs.\n'
fi

cat <<EOF

Next steps
  1. Add this Authorised redirect URI in Google Cloud Console -> Credentials:
       $SERVICE_URL/api/auth/google/callback
  2. For stable OAuth redirects, set APP_ORIGIN=$SERVICE_URL in deploy/aws/.env.aws
     and re-run this script.
  3. Redeploy any time with: bash deploy/aws/deploy.sh

Secrets:      $SECRET_NAME
Photo bucket: $S3_BUCKET
Service ARN:  $SERVICE_ARN_FILE
EOF
