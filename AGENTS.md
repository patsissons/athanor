# athanor (harness)

A harness for driving Claude Code to implement features against well defined tasks.

## Core rules

- Always run `npm run format-and-validate` to validate your code before committing. This single command covers formatting, type checking, linting, and tests — do not run any of these separately as an additional verification step.
- Avoid running end-to-end tests unless you are explicitly asked to do so. these cost real tokens to run. If you need to run them, ask the user if they want to do so.
- The harness intentionally never runs `--dangerously-skip-permissions` outside a disposable worktree. This fact must never be altered.

## Architecture

- The architecture is described in detail inside the `README.md` file, but you should only read it if you need to fully understand the architecture of the harness. in most cases you should be able to understand the necessary details from the context of the code you are reading.
