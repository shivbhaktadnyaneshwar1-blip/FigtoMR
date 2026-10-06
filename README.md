# FigtoMR

FigtoMR turns a Figma frame into a reviewable React/TypeScript component proposal. Review and refine the proposal in the Studio, write it into a local target repository, and optionally open a GitHub pull request or GitLab merge request containing only the generated component folder.

It is repository-aware rather than design-system-specific: it detects the target repository's component location, scripts, formatter, and React dependency before generation.

## Prerequisites

- Node.js 20.19 or later
- npm
- A Gemini API key (`GEMINI_API_KEY` or `GOOGLE_API_KEY`)
- A local checkout of the React application that will receive generated components
- Figma Desktop Dev Mode MCP, or another compatible Figma MCP endpoint with design-context and screenshot tools
- Git installed in the target checkout; a GitHub or GitLab token only when opening a review

## Install and configure

Clone this repository, install its dependencies, and create your local environment file:

```bash
git clone https://github.com/shivbhaktadnyaneshwar1-blip/FigtoMR.git
cd FigtoMR
npm install
cp .env.example .env
```

Set at least these values in `.env`:

```dotenv
GEMINI_API_KEY=your_gemini_key
TARGET_REPO_PATH=/absolute/path/to/your/react-app
```

`.env` is ignored by Git. Do not commit API keys or tokens.

### Configure Figma MCP

By default, FigtoMR connects to Figma Desktop Dev Mode MCP at:

```dotenv
FIGMA_MCP_URL=http://127.0.0.1:3845/mcp
FIGMA_MCP_TRANSPORT=http
```

#### Set up Figma Desktop MCP locally

1. Install and sign in to the [Figma desktop app](https://www.figma.com/downloads/). The local MCP server is provided by the desktop app, not the browser version.
2. Open a Figma design file and switch to Dev Mode.
3. In Figma's desktop-app preferences, enable the local Dev Mode MCP server. The label and location can vary slightly by Figma release; search preferences for **MCP** or **Dev Mode MCP** if it is not immediately visible.
4. Leave Figma Desktop running while you use FigtoMR. Its default local MCP endpoint is `http://127.0.0.1:3845/mcp`.
5. In a terminal, verify the endpoint is reachable:

   ```bash
   curl -i http://127.0.0.1:3845/mcp
   ```

   A response from the local service confirms that the port is available. A `connection refused` error means Figma Desktop is not running or its MCP server is still disabled.

6. Start FigtoMR with `npm run dev:all`, open the Studio, and check the Figma connection in the Connections panel.

Use a node-specific Figma URL when generating, for example:

```text
https://www.figma.com/design/FILE_KEY/Design-name?node-id=123-456
```

The `node-id` selects the exact frame or component FigtoMR should inspect.

#### Local MCP troubleshooting

- Confirm you are using Figma Desktop, not only Figma in a browser.
- Reopen Figma Desktop after enabling its MCP setting.
- Keep the port and URL aligned: `FIGMA_MCP_URL=http://127.0.0.1:3845/mcp`.
- If another local service already uses port `3845`, stop it or configure Figma and `FIGMA_MCP_URL` to use the same alternative endpoint.
- If Figma prompts for access, complete the prompt in Figma before generating. The Studio can also start the supported Figma OAuth flow from its Connections panel.

To use another compatible endpoint, set `FIGMA_MCP_URL` and `FIGMA_MCP_TRANSPORT` (`http`, `sse`, or `stdio`).

### Prepare the target repository

The target must be a local React repository with a `package.json` declaring `react` or `react-dom`. FigtoMR detects:

- Component root: `src/components`, then `components`, otherwise defaults to `src/components`
- Test location: colocated with the component
- Formatter: Biome when `biome.json` or `@biomejs/biome` is present
- Scripts: `build`, `lint:all`/`lint`, `test`, `typecheck`/`lint:types`, and `playground`/`dev`/`start`

For a nonstandard repository, override the detected profile:

```dotenv
TARGET_FRONTEND_PROFILE={"framework":"react","componentRoot":"ui/components","scripts":{"typecheck":"check","preview":"dev"},"previewPath":"/#/components/{{componentName}}"}
```

FigtoMR currently generates React and TypeScript. It returns a clear unsupported-target error for another framework rather than generating code for the wrong stack.

## Run the Studio

Start the API and Vite UI together:

```bash
npm run dev:all
```

Open [http://localhost:5173](http://localhost:5173). The API listens on `http://127.0.0.1:8787`.

End-to-end Studio flow:

1. Confirm the Gemini, Figma, and target-repository connection status in the UI.
2. Paste a Figma design URL containing a `node-id`.
3. Provide a component name or allow FigtoMR to derive one from the frame.
4. Generate a proposal. FigtoMR reads the Figma context and screenshot, detects target conventions, and produces semantic HTML, TypeScript props, CSS, exports, and a colocated test.
5. Review the files and use chat refinement if needed.
6. Stage or approve the proposal. Only `<componentRoot>/<kebab-component-name>/` is eligible to be written.
7. Optionally start the detected preview script and capture a screenshot for visual comparison.
8. Optionally create a GitLab merge request after configuring GitLab credentials.

Generation requires the Gemini key; the Studio API itself can start without one so you can inspect connection state first.

## Run from the CLI

Use the CLI for a direct proposal or write:

```bash
# Preview only (the default)
npm run dev -- "https://www.figma.com/design/FILE_KEY/Name?node-id=123-456" \
  --target-repo /absolute/path/to/your/react-app

# Write the generated component into the target checkout
npm run dev -- "https://www.figma.com/design/FILE_KEY/Name?node-id=123-456" \
  --target-repo /absolute/path/to/your/react-app \
  --name AccountSummary \
  --write
```

Use `npm run dev -- --help` for all CLI options.

## GitHub pull requests and GitLab merge requests

Opening a review is optional. In the Studio, turn on review creation and choose **GitHub** or **GitLab**. Approve uses that selection: GitHub calls `POST /repos/{owner}/{repo}/pulls` with `GITHUB_TOKEN`, and GitLab calls `POST /projects/{path}/merge_requests` with `GITLAB_TOKEN`.

```dotenv
GITHUB_TOKEN=your_github_token
GITLAB_TOKEN=your_gitlab_access_token
GIT_REMOTE_PROJECT=owner/repo
GIT_MR_TARGET_BRANCH=main
```

`GIT_REMOTE_PROJECT` is `owner/repo` for GitHub. GitLab can use a nested path such as `group/subgroup/project`. FigtoMR creates a branch, commits only the proposal-scoped component files, pushes it, and opens the selected review. Keep `STUDIO_DRY_RUN=true` (the default) until you are ready to write to the target repository.

## Environment reference

| Variable                             | Required                            | Purpose                                                     |
| ------------------------------------ | ----------------------------------- | ----------------------------------------------------------- |
| `GEMINI_API_KEY` or `GOOGLE_API_KEY` | For generation                      | Gemini credentials                                          |
| `TARGET_REPO_PATH`                   | For generation, staging, or preview | Absolute local target repository path                       |
| `FIGMA_MCP_URL`                      | No                                  | Figma MCP URL; defaults to Desktop MCP                      |
| `FIGMA_MCP_TRANSPORT`                | No                                  | `http`, `sse`, or `stdio`; defaults to `http`               |
| `TARGET_FRONTEND_PROFILE`            | No                                  | JSON override for detected target conventions               |
| `STUDIO_PREVIEW_URL`                 | No                                  | Preview base URL; defaults to `http://localhost:5173`       |
| `STUDIO_DRY_RUN`                     | No                                  | Defaults to `true`; use `false` to permit writes by default |
| `STUDIO_LOG_LEVEL`                   | No                                  | `debug`, `info`, `warn`, `error`, or `silent`               |
| `GITHUB_TOKEN`                       | For GitHub pull requests            | GitHub API token                                            |
| `GITLAB_TOKEN`                       | For GitLab merge requests           | GitLab API access token                                     |
| `GIT_REMOTE_PROJECT`                 | For either review                   | `owner/repo`, or a GitLab group path                        |
| `GIT_MR_TARGET_BRANCH`               | No                                  | Base branch for the pull request or merge request           |

## Commands

| Command                | What it does                                  |
| ---------------------- | --------------------------------------------- |
| `npm run dev:all`      | Express API and React UI                      |
| `npm run dev:server`   | API only on `http://127.0.0.1:8787`           |
| `npm run dev:ui`       | Vite UI only on `http://localhost:5173`       |
| `npm run build`        | Type-check and build the UI                   |
| `npm run typecheck`    | Run TypeScript checks without emitting output |
| `npm test`             | Run the Vitest suite                          |
| `npm run format:check` | Check Prettier formatting                     |
| `npm run format`       | Apply Prettier formatting                     |

## Verify the installation

```bash
npm run typecheck
npm test
```

If `npm install` fails resolving a private package mirror, use the npm registry and credentials configured for your environment, then rerun the command. The repository pins compatible OpenTelemetry packages because some mirrors do not publish the latest matching trace package.
