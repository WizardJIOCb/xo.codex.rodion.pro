# AGENTS.md

## Project Notes

- This project has Playwright installed locally for UI checks.
- On Windows PowerShell, run Playwright through `npm.cmd run pw -- ...`.
- Do not use bare `npx`; PowerShell may resolve it to `npx.ps1`, which can be blocked by ExecutionPolicy.
- Avoid downloading Playwright during a Codex task. Use the local package and the browser cache in `%LOCALAPPDATA%\ms-playwright`.
