# Working on Penumbra

Penumbra uses a git worktree layout so several agents can work in parallel without
fighting over one checkout. `main` is the integration branch; nothing lands there except
a merged, verified phase.

## Layout

```
F:/Penumbra                     main        — integration branch, always green
F:/Penumbra-worktrees/<slug>    <slug>      — one directory per unit of work
```

Each worktree is a full checkout with its own `node_modules`, so tests in one never
interfere with another's build output.

## Starting work

```bash
# create + enter a worktree on a new branch
git worktree add -b phase-1-canvas-engine \
  F:/Penumbra-worktrees/phase-1-canvas-engine main

cd F:/Penumbra-worktrees/phase-1-canvas-engine
pnpm install
```

If you are working inside Claude Code, the session can create and enter the worktree for
you — ask it to start work on a named branch.

## Finishing work

```bash
cd F:/Penumbra-worktrees/phase-1-canvas-engine

pnpm typecheck && pnpm lint && pnpm test:unit && pnpm build   # must be green

git push -u origin phase-1-canvas-engine
```

Then open a pull request. `main` is never edited directly.

## Housekeeping

```bash
git worktree list                        # what exists
git worktree remove F:/Penumbra-worktrees/<slug>   # after merge
git worktree prune                       # clean up entries whose dirs are gone
```

Never delete a worktree directory by hand — remove it through `git worktree remove`, or
git will keep a stale entry pointing at a path that no longer exists.

## Branch naming

| Prefix | Use |
|---|---|
| `phase-N-<slug>` | Feature work for a phase in `docs/TASKS.md` |
| `fix-<slug>` | Bug fix |
| `docs-<slug>` | Documentation or spec change |
| `chore-<slug>` | Tooling, dependencies, CI |

## Before any commit

Phase 0 established these gates. All of them must pass locally — CI will run the same
commands, and a red build costs a round trip:

```bash
pnpm typecheck
pnpm lint
pnpm test:unit
pnpm build
```

Add `pnpm test:perf` if you touched spatial indexing, and `pnpm test:e2e` if you touched
rendering.
