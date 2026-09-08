# AGENTS.md

Echoriad is a Pi extension that lets developers run agent tools inside a Gondolin micro-VM. See `CONTEXT.md` for the domain model and ubiquitous language.

## Repository layout

```
echoriad/
├── index.ts                     # extension entrypoint — the Gondolin tool router
├── src/                         # one module per extension concern
│   ├── authorization.ts         # build-approval associations, cached and revocable
│   ├── config.ts                # config loading and image-source selection
│   ├── fingerprint.ts           # semantic build-config fingerprints
│   └── guest-image.ts           # automatic guest image builds and build cache
├── test/                        # node:test suites (run with npm test)
│   └── fixtures/                # shared test fixtures
├── docs/
│   ├── adrs/                    # immutable decision records
│   ├── style/                   # per-language and prose style guides
│   └── agents/                  # how engineering skills consume the docs
├── .tracker/<feature>/          # the unit-of-work tracker (see Agent skills)
├── CONTEXT.md                   # domain model and ubiquitous language — read first
├── AGENTS.md                    # this file
├── biome.json                   # formatter and linter configuration
├── mise.toml                    # pinned toolchain
└── package.json                 # scripts and the extension manifest
```

## Setup

The toolchain is pinned in `mise.toml`. Run `mise install` to get everything you need.

## Build and test

There is no build step: Node runs the TypeScript source directly via type stripping. `npm run build` and `npm run clean` are placeholders.

- `npm test` — run the `node:test` suites in `test/`
- `npm run check` — Biome check; the gate for formatting and lint
- `npm run fix` — apply Biome's safe fixes

## Code style

TypeScript coding guidelines can be found in `docs/style/typescript.md`. Prose guidelines are in `docs/style/prose.md`.

## Agent skills

### Issue tracker

Issues are tracked as local Markdown files under `.tracker/<feature>/`. See `docs/agents/issue-tracker.md`.

### Triage labels

Triage uses the default five canonical label strings. See `docs/agents/triage-labels.md`.

### Domain docs

This repository uses the single-context domain-doc layout. See `docs/agents/domain.md`.
