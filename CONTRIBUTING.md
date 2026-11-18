# Contributing

Report bugs and request features as issues in this repository. Discuss bigger changes there before writing a PR. Report security bugs by email instead: see [SECURITY.md](SECURITY.md). Keep PRs small and add tests for behaviour changes.

## Setup

Install Node 22.18 or newer, Git, Google Chrome and `ffmpeg`, then `npm ci`. The unit tests need no GPU, Chrome or network. The smoke tests render real frames and need a GPU that headless Chrome can use (tested on Linux with Vulkan).

## Checks

```sh
npm run check            # typecheck + unit tests (what CI runs)
scripts/scrub-check      # private addresses, home folders, email addresses, token formats
npm run smoke:engine     # renders the demo and showcase worlds on WebGPU and WebGL 2 (GPU)
npm run smoke:viewer     # the live viewer (GPU)
npm run eval:mcp         # the MCP server end to end against a mock gen worker (GPU)
npm run parity:render    # render-mode frame hashes against a base ref (GPU)
(cd workers/server && python3 -m unittest discover -s tests -t .)   # gen worker, no GPU
```

`scripts/scrub-check` fails on hits that are not listed in `.scrub-allow`. Use made-up examples in code, fixtures and docs: user `sam` (`/home/sam`), host `gpu-box`, `example.com`.

## Formats

Changes to the world, op, camera-script, page or worker formats need the schema (`src/schema/`), [CONTRACT.md](CONTRACT.md) and tests in the same PR. Render mode must stay frame-exact: run `npm run parity:render` for any engine change and say in the PR if frames changed on purpose.

New dependencies need a licence compatible with Apache-2.0 (no GPL, AGPL or non-commercial). New binary assets need a line in the folder's provenance file (for example `worlds/showcase/ASSETS.md`) with source and licence. Gen-worker defaults must be commercially usable models; research-only weights are never a default.

PRs target `main`. Write what users will notice in CHANGELOG.md. By sending a PR you agree that your change is licensed under Apache-2.0, like the rest of the project.
