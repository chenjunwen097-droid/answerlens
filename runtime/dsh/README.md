# dsh (DeepSeek Harness) integration — M3.1

Verified against `@deepseek-ai/dsh@0.2.1-rc.2` on 2026-10-29.

## What the SDK profile is

`dsh --profile sdk` serves **newline-delimited JSON-RPC over stdio** for one
runtime until the client disconnects. `dsh --profile sdk --dump-config` prints
the composed plugin tree (`@deepseek-ai/dsh-base` + `@deepseek-ai/dsh-sdk-app`
patches). The model, provider and cwd arrive in the SDK initialization request.

## What dsh already provides

- `@deepseek-ai/dsh-tool-web` → `web_search` / `web_fetch` (`ctx.web` backends)
- `@deepseek-ai/dsh-tool-subagent` → managed child agents with presets and a
  delegation depth limit
- `@deepseek-ai/dsh-tools` → `defineTool(...)` for registering a model-facing tool
- `@deepseek-ai/dsh-tool-present` → deliverables

So the multi-agent work is mostly **composition**, not new plumbing.

## Plan

1. `answerlens-report-tools` Cordis plugin: register `get_report` and
   `compare_reports` over the runtime SQLite store with `defineTool`.
2. Agent presets:
   - `orchestrator`: `dsh-tool-web` + `dsh-tool-subagent` + report tools
   - `researcher`: `dsh-tool-web` only, low search budget
   - `report-agent`: report tools + `dsh-tool-web` (2 searches)
3. A profile patch that mounts the plugin and presets into `sdk`.
4. A stdio JSON-RPC client in the runtime: spawn `dsh --profile sdk`,
   initialize (provider/model/cwd), send the user message, map dsh events to the
   existing `/v1/chat` SSE frames.
5. Contract tests: same prompts through the current agent layer and through dsh;
   compare tool calls, latency and final text.

## Status

- [x] dsh installed and CLI verified locally
- [x] SDK profile dumped; built-in web/subagent tools identified
- [ ] report-tools plugin
- [ ] presets + profile patch
- [ ] stdio client + SSE mapping
- [ ] contract tests + deploy

The current production runtime (0.4.0) keeps using `runtime/agents.mjs`; it is
not replaced until the dsh path passes the contract tests.
