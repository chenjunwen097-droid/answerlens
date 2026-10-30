# DeepSeek Harness integration

AnswerLens uses `@deepseek-ai/dsh@0.2.1-rc.2` for the conversational agent layer.
The deterministic analysis pipeline stays separate: dsh does not generate or
alter scores.

## Runtime shape

```text
POST /v1/chat
  └── runtime/dsh/client.mjs
        └── one isolated dsh stdio process
              ├── sdk-minimal profile
              ├── answerlens-dsh-runtime/patch.yml
              └── orchestrator | researcher | report-agent preset
```

Each chat request starts its own dsh process and session. This prevents users
from sharing in-memory agent state. The process is closed after the answer is
committed.

## Roles

- `orchestrator`: default chat scope. Can search the web, discover reports,
  prepare an analysis card, and delegate independent work.
- `researcher`: temporary child agent with web-only tools and a small search
  budget. It returns sourced facts, not final recommendations.
- `report-agent`: selected deterministically when the request has a report
  context. It can read and compare stored reports and perform a small web
  verification when required.

Reports remain resources. There is one logical Report Agent parameterized by
`reportId`; report count does not create idle agents.

## Tools

Local Cordis plugin in `plugins/report-tools.mjs`:

- `list_reports`
- `get_report`
- `compare_reports`

Built-in dsh tools:

- `web_search`
- `web_fetch`
- `subagent` with preset allowlist

`plugins/analysis-tool.mjs` exposes `prepare_analysis`. The runtime applies an
additional verbatim-source check, so the UI only receives a detection card when
the brand, competitors and directions appear in the user's message.

## Configuration

`patch.yml` is loaded over `sdk-minimal`. It disables shell and filesystem tools,
enables DeepSeek Search/Fetch, mounts the three presets, and installs a binder
that selects the preset before the first turn.

The profile home must be inside `runtime/dsh` so Node can resolve the local
`@answerlens/dsh-plugins` package. Every request gets a unique
`runtime/dsh/.runtime-home/request-*` home, which is removed after the dsh
process closes. This prevents concurrent users from sharing profile locks or
session state.

Required environment:

```text
DEEPSEEK_API_KEY=
DATA_DIR=/data
DSH_MODEL=deepseek-flash
DSH_MAX_TOKENS=1800
AGENT_ENGINE=dsh
```

Reasoning is configured as `off` for the assistant runtime. This keeps latency
and output-token use predictable; it does not affect the measured models in the
analysis pipeline.

## Verification

Unit tests validate source-grounded brief extraction and context composition:

```bash
npm test
```

Real-model contract tests additionally verify the Orchestrator and Report Agent:

```bash
RUN_DSH_CONTRACT=1 npm test
```

The report-agent contract writes a temporary SQLite report and requires the
answer to come back through the real dsh report tools.
