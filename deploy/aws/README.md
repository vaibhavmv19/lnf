# Hosting Lost N Found on AWS

The app is a single Node.js HTTP server (`server.js`) with static files in
`public/`. The prepared AWS target is **Amazon ECS Express Mode**: one container
on Fargate behind an internet-facing Application Load Balancer with HTTPS, plus
CloudWatch logs and autoscaling.

Express Mode is AWS's recommended path for new containerized apps. (AWS App
Runner stopped accepting new customers on 30 April 2026; it is not used here.)

```
Internet -> ALB (HTTPS, *.ecs.<region>.on.aws) -> Fargate task (node server.js :3000)
                                                        |
                                                        +-> Amazon RDS Postgres (data)
                                                        +-> Amazon S3 (photos)
```

## What is already prepared

| File | Purpose |
| --- | --- |
| `Dockerfile` | Production image: Node 22, non-root `node` user, `/health` healthcheck, `node server.js` entrypoint, no `.env` baked in. |
| `deploy/aws/deploy.sh` | Idempotent deploy: builds and pushes to ECR, creates the IAM roles, creates/opens the S3 bucket, stores secrets in Secrets Manager, creates or updates the Express Mode service, waits for it, then checks `/health`. |
| `deploy/aws/.env.aws.example` | Template for deployment settings and application environment variables. |
| `deploy/aws/rds-schema.sql` | Table schema for the RDS store (`lnf_*` tables, one row per record). |
| `.dockerignore` | Keeps `.env`, local data, uploads, docs and `deploy/` out of the image. |

The store (`server/store.js`) keeps the dataset in memory and uses:

1. **RDS Postgres** when `RDS_DATABASE_URL` is set — each collection is its own
   table, so two tasks can never overwrite each other's snapshot;
2. `data/db.json` on disk otherwise, which is **ephemeral on Fargate**;
3. memory only when the filesystem is read-only.

Photos go to **S3** (`S3_BUCKET`) and are served as public object URLs; without
S3 they are written to `public/uploads/` and lost on the next deploy.

## Prerequisites

- AWS account with ECR, ECS, IAM, S3, Secrets Manager, CloudWatch and RDS access.
- AWS CLI v2 configured (`aws configure`, then `aws sts get-caller-identity`).
- Docker running locally.
- The default VPC in your region (Express Mode uses it unless you pass
  `--network-configuration`).

## Step 1: create the database

1. RDS → Create database → **PostgreSQL**, template **Free tier**.
2. Settings: DB instance identifier `lnf-db`, master user `lnf`, generate and
   save a strong password. Initial database name: `lnf`.
3. Instance: `db.t4g.micro`, 20 GiB gp3, **Public access: Yes** for the simplest
   setup (see [Networking](#networking)).
4. Connectivity: default VPC, allow port `5432` from your own IP while you set
   it up, and from the Express service's tasks afterwards.
5. When it is available, copy the endpoint and build the connection string:

   ```
   postgresql://lnf:<password>@<endpoint>:5432/lnf?sslmode=require
   ```

6. Apply the schema from this repo (locally, with `psql`):

   ```bash
   psql "postgresql://lnf:<password>@<endpoint>:5432/lnf?sslmode=require" \
     -f deploy/aws/rds-schema.sql
   ```

   If you change `RDS_TABLE_PREFIX`, rename the tables in that file to match.

You can also use `psql` on the query editor in the RDS console if you prefer.

## Step 2: deploy

1. Create the settings file:

   ```bash
   cp deploy/aws/.env.aws.example deploy/aws/.env.aws
   ```

2. Fill it in:

   - `SESSION_SECRET` — required. `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
   - `RDS_DATABASE_URL` — from step 1.
   - `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_ALLOWED_DOMAIN`.
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

5. Set `APP_ORIGIN` to the printed service URL and re-run the script once, so
   OAuth does not depend on the load balancer's `Host` header.

Redeploys use the same command; the service ARN is cached in
`deploy/aws/.service-arn`, so the script updates the existing service instead of
creating a second one.

## Configuration

Plain values become container environment variables; the three secrets are
written to a Secrets Manager secret (`<SERVICE_NAME>/app`) and injected with the
ECS `secrets` block, so they never appear in the task definition or CloudWatch.

| Variable | Required | Notes |
| --- | --- | --- |
| `SESSION_SECRET` | yes | Signs stateless session cookies. Without it sessions break on restart/scale-out. |
| `RDS_DATABASE_URL` | strongly recommended | Postgres connection string. Without it data lives on the task filesystem and is lost on restart. |
| `RDS_TABLE_PREFIX` | no | Defaults to `lnf_`; must match the schema file. |
| `APP_ORIGIN` | recommended | Public HTTPS origin, e.g. `https://lost-n-found-abc123.ecs.us-east-1.on.aws`. Used for OAuth redirects and QR links. |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | for sign-in | Google OAuth web client. |
| `GOOGLE_ALLOWED_DOMAIN` | no | Defaults to `mys.rvu.edu.in`; the ID token's `hd` claim is checked too. |
| `S3_BUCKET` | no | Defaults to `lnf-photos-<account-id>`; created by the script. |
| `S3_REGION` | no | Defaults to `AWS_REGION`. |
| `PORT` | no | Container default `3000`; keep `CONTAINER_PORT=3000` in sync. |
| `CAMPUS_NAME` | no | Defaults to `RVU Mysore`. |

The task role (`lnfTaskRole`) gets `s3:PutObject`/`s3:GetObject` on the bucket, so
no AWS keys are stored anywhere.

## Networking

Express Mode tasks run in the default VPC's public subnets with a public IP, so
they can reach an RDS instance whose security group allows port 5432 from the
internet (still protected by the database password and TLS). For a tighter setup:

- create the RDS instance with **Public access: No**, and
- add an inbound rule on its security group for the tasks' security group or the
  default VPC CIDR, then pass `--network-configuration` when creating the service.

The security group Express Mode creates is managed by ECS and is visible on the
service in the console; reference it from RDS once the service exists.

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

Delete everything created by the deploy:

```bash
aws ecs delete-express-gateway-service --service-arn "$(cat deploy/aws/.service-arn)"
```

Then remove the ECR repository, the S3 bucket, the Secrets Manager secret, the
three IAM roles and the RDS instance if you no longer need them.

## Cost

Express Mode has no service fee; you pay for the resources. With the defaults
(`CPU=512`, `MEMORY=1024`, one task):

- Fargate: ~$18/month for 0.5 vCPU + 1 GiB running continuously.
- Application Load Balancer: ~$16-20/month plus a small LCU charge.
- RDS `db.t4g.micro`: free for 12 months on the free tier, then ~$12-15/month.
- S3: a few cents for photo storage and requests.

Roughly **$35-40/month** on the free tier, **$50+** afterwards. The ALB is not
covered by the free tier.

## Security notes

- `.env` used to be committed to this repository, which exposed
  `GOOGLE_CLIENT_SECRET` and `SESSION_SECRET`. It is now git-ignored and tracked
  as removed; **rotate both values** and purge the file from history
  (`git filter-repo --path .env --invert-paths`, or the BFG) before relying on
  the repo being private.
- Photo objects in the bucket are publicly readable by design (anyone with the
  URL can view them). Do not store private documents there.
- All other data lives in RDS and is only reachable with the database password.

## Troubleshooting

- **Service not ACTIVE / tasks stopping:** check CloudWatch logs. The usual
  causes are a missing `SESSION_SECRET`, a bad `RDS_DATABASE_URL`, or no route to
  RDS on port 5432.
- **`/health` returns 503:** the store failed to initialise; look for `[store]`
  and `[init]` lines.
- **Data resets after a deploy:** `RDS_DATABASE_URL` is empty or the connection
  fails (`[store] RDS unavailable`).
- **Photos missing:** the S3 upload failed; look for `[uploads] S3 upload failed`
  and check the task role policy and bucket name. Without S3, photos fall back to
  the container filesystem and disappear on restart.
- **Google sign-in fails with `redirect_uri_mismatch`:** the registered URI must
  match exactly, including `https://` and `/api/auth/google/callback`. Set
  `APP_ORIGIN`, register it, then redeploy.

## Verification

The image was prepared and reviewed but not built in this environment because
Docker is not installed on this machine. Before the first real deploy:

```bash
docker build -t lost-n-found .
docker run --rm -p 3000:3000 -e SESSION_SECRET=dev-secret lost-n-found
curl http://localhost:3000/health
```
