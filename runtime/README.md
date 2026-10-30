# AnswerLens runtime

The long-lived backend that Vercel cannot host. It owns the SSE protocol, the
SQLite store, and the DeepSeek Harness (dsh) agent runtime.

## Deploy (Shenzhen ECS example)

```bash
cd /opt/answerlens-runtime
# .env: PORT, RUNTIME_TOKEN, DATA_DIR, model keys
docker build -t answerlens-runtime:0.5.2 .
docker run -d --name answerlens-runtime --restart unless-stopped \
  -p 80:8787 --env-file .env \
  -v /opt/answerlens-runtime/data:/data answerlens-runtime:0.5.2
```

- The base image uses `docker.m.daocloud.io` because Docker Hub is unreachable
  from the Shenzhen host.
- `GET /health` is public; every `/v1/*` route requires `Authorization: Bearer
  <RUNTIME_TOKEN>`.
- SQLite lives in `/data` (mounted volume). Node 22's `node:sqlite` is used with
  `--experimental-sqlite`; if it is unavailable the service falls back to a JSON
  file store and `/health` reports it.

## API

| Route | Description |
| --- | --- |
| `GET /health` | version, storage backend, agent engine, configured providers |
| `POST /v1/chat` | SSE: `token` / `blocks` / `done` |
| `POST /v1/runs` | SSE: `stage` ×6 → `report` |
| `GET /v1/reports` | stored reports |
| `POST /v1/reports` | persist a report |

## dsh

Set `AGENT_ENGINE=dsh` to route `/v1/chat` through DeepSeek Harness. The
deterministic analysis pipeline remains responsible for question generation,
12 measured answers, judging and score aggregation.

The dsh image is preinstalled from `dsh/package-lock.json`; runtime configuration
lives in `dsh/patch.yml`. See [dsh/README.md](dsh/README.md).
