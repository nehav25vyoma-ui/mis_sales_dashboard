# MIS Sales Dashboard

## Deploying to Vercel

Import the repository into Vercel and leave the project Root Directory at the
repository root. The included `vercel.json` builds `frontend/` and sends all
`/api/*` requests to the FastAPI serverless function.

Before deploying, add the PostgreSQL connection string under **Project
Settings > Environment Variables**:

```text
DATABASE_URL=postgresql://USER:PASSWORD@HOST:5432/DATABASE?sslmode=require
```

Alternatively, configure `DATABASE_HOST`, `DATABASE_PORT`, `DATABASE_NAME`,
`DATABASE_USER`, and `DATABASE_PASSWORD` individually. Apply the variables to
Production (and Preview if preview deployments need database access), then
redeploy.

After deployment, verify these URLs:

- `/api/health` returns `{"status":"ok"}`.
- `/api/db-test` returns `{"message":"Database Connected Successfully"}`.

Do not commit a real `.env` file or database password.
