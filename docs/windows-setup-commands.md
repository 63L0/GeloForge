# GeloForge commands for Furniture Bot v4

## Start in the project folder

Open PowerShell. The `gf` function below is a shortcut for the published GeloForge v0.7.0 CLI. Run these lines again in a new PowerShell window.

```powershell
$projectPath = Read-Host 'Paste the full path to furniture-bot-v4-baseline'
Set-Location -LiteralPath $projectPath
function gf { npx --yes geloforge@0.7.0 @args }
gf --version
gf status
gf validate
```

- `status` shows project health, tasks, and active leases.
- `validate` checks project files and references. Workflow behavior is checked separately by your tests.
- For a new project folder, run `gf adopt --dry-run` to preview changes, then `gf adopt` to add the GeloForge files. Skip adoption for an already adopted folder.

## Connect your agent

For Antigravity, keep the existing `geloforge` entry in its MCP config. Its launch arguments should end with:

```text
geloforge mcp --project "<full path to furniture-bot-v4-baseline>" --read-only
```

This is the server command your IDE launches over stdio. Use `gf mcp init --client gemini --read-only --dry-run` and then `gf mcp init --client gemini --read-only` only for Gemini CLI configuration. Built-in client names also include `cursor`, `vscode`, and `claude`.

In Antigravity or Codex, ask: “Call `geloforge_context` with `skills: true` for the active Furniture Bot workflows. Tell me which skill matches.” Both agents should point to the same project folder. The MCP read-only flag applies to GeloForge's tools. n8n access is configured separately.

## Find the next task and load context

| PowerShell command | What it does |
|---|---|
| `gf recommend` | Shows suggested next actions and pending approvals. |
| `gf task list` | Lists saved project tasks. |
| `gf task new --title 'Audit Furniture Bot staging workflow' --activate` | Creates and activates a task. Use the ID it prints in later commands. |
| `gf task show --task TASK-0001` | Shows the task and its linked evidence. |
| `gf context --task TASK-0001 --skills --profile quick` | Loads focused task context and matching project skills. |
| `gf context --query 'Trace the quotation handoff' --skills --profile working` | Loads context for a question before a task exists. |
| `gf skills list` | Lists skills visible to this project. |
| `gf skills validate` / `gf skills lint --strict` | Checks skill structure and flags quality or safety issues. |
| `gf task leases` | Shows active claims on task or file scopes. |

Replace example IDs and scopes with the ones in your project. For concurrent edits, claim and release the same task using the same tool and session labels:

```powershell
gf task claim --task TASK-0001 --tool codex --session audit-1 --scope workflows
gf task release --task TASK-0001 --tool codex --session audit-1
```

## Record evidence and hand off

Replace `node --test` with the actual local or staging test command for your project. This example assumes there are Node tests in the project folder.

```powershell
gf evidence capture --task TASK-0001 --name 'Staging checks' -- node --test
gf checkpoint create --summary 'Reviewed routing' --resume 'Check quotation handoff'
gf checkpoint list
gf checkpoint show
gf handoff --task TASK-0001 --from-tool codex --to-tool antigravity --next-action 'Review the staging evidence'
```

Evidence capture records the command result while keeping the task open. The checkpoint preserves progress for a later session. Use `gf handoff --inspect '<handoff-file>'` with the saved path to review the handoff.

When a passing test should also finish the task, use:

```powershell
gf verify --task TASK-0001 -- node --test
```

A pass saves verified evidence and a checkpoint, then completes the task. A failure saves draft evidence and leaves the task open.

## Current automation

With the published v0.7.0 commands above, you start the task. The agent can look up skills when the project instructions ask it to do so. The release includes the [Autonomous Mode staging worker](./advanced-usage.md#autonomous-mode-staging-pilot) for automatic n8n delivery and a command for checking saved local failures.

For more options, run `gf --help` or `gf <command> --help`.
