# Hosting Lost N Found on AWS

This app is a single Node.js HTTP server (`server.js`) plus static files in
`public/`. The prepared AWS target is **Amazon ECS Express Mode**: one container
on Fargate, behind an internet-facing Application Load Balancer with HTTPS, plus
CloudWatch logs and autoscaling.

Express Mode is AWS's recommended path for new containerized apps. (AWS App
Runner stopped accepting new customers on 30 April 2026; it is not used here.)

```
Internet -> ALB (HTTPS, *.ecs.<region>.on.aws) -> Fargate task (node server.js :3000)
                                                        |
                                                        +-> Supabase (data + photo bucket)
```

## What is already prepared

| File | Purpose |
| --- | --- |
| `Dockerfile` | Production image: Node 22, non-root `node` user, `/health` healthcheck, direct `node server.js` entrypoint, no `.env` baked in. |
| `deploy/aws/deploy.sh` | Idempotent deploy: builds and pushes the image to ECR, creates the two required IAM roles, stores secrets in Secrets Manager, creates or updates the Express Mode service, waits for it, then checks `/health`. |
| `deploy/aws/.env.aws.example` | Template for the deployment settings and application environment variables. |
| `.dockerignore` | Keeps `.env`, local data, uploads, docs and the deploy folder out of the image. |

## Prerequisites

- An AWS account with permission to use ECR, ECS, IAM, Secrets Manager and CloudWatch.
- AWS CLI v2 configured (`aws configure`, then `aws sts get-caller-identity`).
- Docker running locally.
- A **default VPC with public subnets** in the target region, or pass your own
  subnets with `--network-configuration` (see the CLI reference below).
- A Supabase project if you want data to survive restarts (strongly recommended,
  see [Persistence](#persistence)).

## Deploy

1. Create the settings file:

   ```bash
   cp deploy/aws/.env.aws.example deploy/aws/.env.aws
   ```

2. Fill in `deploy/aws/.env.aws`:

   - `SESSION_SECRET` — required. Generate one:
     `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
   - `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_ALLOWED_DOMAIN` for sign-in.
   - `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_PHOTO_BUCKET` for persistence.
   - `AWS_REGION` if you are not deploying to `us-east-1`.

3. Deploy:

   ```bash
   bash deploy/aws/deploy.sh
   ```

   The first run takes several minutes (image push, ALB and HTTPS provisioning).
   The script prints the service URL, the health URL and the Google redirect URI.

4. Register the redirect URI in Google Cloud Console → APIs & Services →
   Credentials → your OAuth client:

   ```
   https://<service-url>/api/auth/google/callback
   ```

5. Set `APP_ORIGIN` to the printed service URL and re-run the script once. This
   pins the OAuth redirect URI instead of deriving it from the request `Host`
   header, so sign-in keeps working if the load balancer URL ever changes.

Redeploys use the same command; the service ARN is cached in
`deploy/aws/.service-arn`, so the script updates the existing service instead of
creating a second one.

## Configuration

Non-secret values are passed as plain container environment variables.
`GOOGLE_CLIENT_SECRET`, `SESSION_SECRET` and `SUPABASE_SERVICE_ROLE_KEY` are
written to a Secrets Manager secret (`<SERVICE_NAME>/app`) and injected with the
ECS `secrets` block, so they never appear in the task definition or in
CloudWatch.

| Variable | Required | Notes |
| --- | --- | --- |
| `SESSION_SECRET` | yes | Signs stateless session cookies. Without it, sessions live in memory and break on restart/scale-out. |
| `APP_ORIGIN` | recommended | Public HTTPS origin, e.g. `https://lost-n-found-abc123.ecs.us-east-1.on.aws`. Used for OAuth redirects and QR links. |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | for sign-in | Google OAuth web client. |
| `GOOGLE_ALLOWED_DOMAIN` | no | Defaults to `mys.rvu.edu.in`; sign-in also checks the token's `hd` claim. |
| `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` | recommended | Enables durable data and Supabase Storage photo uploads. `supabase_schema.sql` creates the tables. |
| `SUPABASE_PHOTO_BUCKET` | no | Defaults to `lnf-photos`. |
| `PORT` | no | Container default is `3000`; keep `CONTAINER_PORT=3000` in sync if you change it. |
| `CAMPUS_NAME` | no | Defaults to `RVU Mysore`. |

## Persistence

Fargate's filesystem is ephemeral. Without Supabase configured, the app still
runs, but:

- the dataset (`data/db.json` in-container) is lost on every restart or deploy;
- uploaded photos are written to `public/uploads/` and lost the same way.

Configure `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` (service role key, used
server-side only) and run `supabase_schema.sql` once in the Supabase SQL editor.
On first boot the app uploads its seed dataset, then keeps reading and writing
Supabase; photos go to the configured Storage bucket. Keep `MIN_TASKS=1` for the
first boot so two fresh tasks cannot seed the same empty database concurrently.

If you need object storage inside AWS instead, S3 can replace the Supabase
Storage upload in `putPhoto` (`server/store.js`), which `saveDataImage`
(`server/api.js`) calls before falling back to local disk; the database layer
would need a separate adapter.

## Operating the service

```bash
# Current state and public endpoint
aws ecs describe-express-gateway-service \
  --service-arn "$(cat deploy/aws/.service-arn)" \
  --query 'service.{status:status.statusCode,url:ingressPaths[0].endpoint}'

# Follow container logs
aws logs tail /ecs/<SERVICE_NAME> --follow

# Roll out a new image (rebuild + push + update)
bash deploy/aws/deploy.sh
```

Delete everything created by the deploy with the ECS console, or:

```bash
aws ecs delete-express-gateway-service --service-arn "$(cat deploy/aws/.service-arn)"
```

Then delete the ECR repository, the Secrets Manager secret and the two IAM roles
if you no longer need them.

## Cost

Express Mode has no service fee; you pay for the underlying resources. With the
defaults here (`CPU=512`, `MEMORY=1024`, one task) expect roughly:

- Fargate: ~$18/month for 0.5 vCPU + 1 GiB running continuously.
- Application Load Balancer: ~$16-20/month plus a small LCU charge.

So about **$35-40/month**. The ALB is not covered by the AWS free tier. Lower
`CPU`/`MEMORY` or use Lightsail/Elastic Beanstalk if you need a cheaper
single-instance alternative.

## Manual console path

If you prefer the console instead of the script:

1. ECR → create repository → use the "View push commands" to build and push the
   image (`docker build --platform linux/amd64 -t <uri> .`).
2. Create the IAM roles described in the Express Mode first-run flow
   (`ecsTaskExecutionRole` with `AmazonECSTaskExecutionRolePolicy`, and
   `ecsInfrastructureRoleForExpressServices` with
   `AmazonECSInfrastructureRoleforExpressGatewayServices`).
3. ECS → Clusters → Create Express Mode service → choose the ECR image.
4. Container port `3000`, health check path `/health`, CPU `512`, memory `1024`,
   min/max tasks `1`.
5. Add the environment variables and Secrets Manager references listed above.
6. After creation, copy the service URL, add the Google redirect URI, then update
   `APP_ORIGIN`.

## Troubleshooting

- **Service not ACTIVE / tasks stopping:** open CloudWatch logs for the service.
  The usual cause is a missing `SESSION_SECRET` or a bad Supabase key.
- **`/health` returns 503:** the store failed to initialise. Check the log line
  starting with `[store]`.
- **Google sign-in fails with `redirect_uri_mismatch`:** the registered URI must
  match exactly, including `https://` and `/api/auth/google/callback`. Set
  `APP_ORIGIN` and redeploy after registering it.
- **Photos disappear:** Supabase Storage is not configured, or the bucket is not
  public-read.
- **Data disappears after a deploy:** Supabase is not configured.

## Files and verification

The image was prepared and reviewed but not built in this environment because
Docker is not installed on this machine. Before the first real deploy, run:

```bash
docker build -t lost-n-found .
docker run --rm -p 3000:3000 -e SESSION_SECRET=dev-secret lost-n-found
curl http://localhost:3000/health
```
