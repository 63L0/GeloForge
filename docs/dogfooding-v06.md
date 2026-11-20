# Dogfooding v0.6 on GeloForge

The 15-second [terminal replay](./media/geloforge-v06-demo.gif) condenses a run on a disposable Git worktree of the GeloForge repository at `f583141`, using the adoption fix in this PR. Two scripted stdio MCP clients sent actual tool requests to separate GeloForge server processes in the same worktree.

| Action | Observed result |
| --- | --- |
| Run `geloforge mcp init` | Cursor, VS Code, Claude Code, and Gemini CLI project configuration and instructions were generated. |
| Review the verification quickstart in client A | `TASK-0001` acquired a lease for `docs/quickstart-5min.md`. |
| Request the same file in client B | `TASK-0002` received a scope collision and could not acquire the lease. |
| Run the repository's `tests/verify.test.mjs` through `geloforge verify` | The command passed, `EVID-0001` was verified, `CHKPT-0001` was saved, and `TASK-0001` was completed. |
| Draft a reusable verification skill in client B | The MCP server drafted `verify-quickstart` in quarantine using `EVID-0001`. The local CLI used a disposable Ed25519 key to sign `APPR-0001`. |

The initial adoption failed because the validator flagged unrendered tokens in GeloForge's own source templates. Placeholder validation now covers project memory and agent guides, so a repository can keep its template source files and adopt GeloForge.

The replay establishes the MCP tool behavior across two scripted sessions. A live paired IDE session with Codex and Gemini remains to be recorded. The signing key was generated for this run and discarded with the worktree.

Run the same workflow from a GeloForge Git checkout with Node.js and Git installed.

```bash
node scripts/demo-v06.mjs
```

The script checks each tool result, verifies the resulting project, and removes its temporary worktree.
