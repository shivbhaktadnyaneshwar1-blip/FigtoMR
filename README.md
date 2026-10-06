# FigtoMR

Turn a Figma frame into a React component scaffold, review it in chat, then write it into a local git repo and optionally open a merge request.

This project is generic: Google Gemini (ADK), Figma MCP, semantic HTML + CSS. It does not depend on any company design system or private npm registry.

## Quick start

```bash
npm install
cp .env.example .env
# Set GEMINI_API_KEY and TARGET_REPO_PATH
npm run dev:all
```

Open **http://127.0.0.1:5173** (dev UI) or build and use **http://127.0.0.1:8787**.

## Environment

See `.env.example`. Required for generation:

- `GEMINI_API_KEY` or `GOOGLE_API_KEY`
- `TARGET_REPO_PATH` — local checkout where `src/components/<kebab>/` is written

Optional:

- `FIGMA_MCP_URL` (default desktop MCP `http://127.0.0.1:3845/mcp`)
- `STUDIO_PREVIEW_URL` for visual compare
- `GITLAB_TOKEN` / `GITHUB_TOKEN` + `GIT_REMOTE_PROJECT` for merge requests

Never commit `.env`. Keys stay local.

## Commands

| Command | What it does |
| --- | --- |
| `npm install` | Install deps from the public npm registry |
| `npm run dev:all` | Express API + React UI |
| `npm run dev:server` | API only (`http://127.0.0.1:8787`) |
| `npm run dev:ui` | Vite UI (`http://127.0.0.1:5173`) |
| `npm test` | Vitest |
| `npm run typecheck` | `tsc --noEmit` |

## Flow

```text
React UI → POST /api/generate (SSE)
  → ADK agent + Figma MCP
  → React component scaffold (preview)
  → Approve → write TARGET_REPO_PATH
  → optional git merge request
```
