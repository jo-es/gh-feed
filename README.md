# gh-reader (`ghr`)

Ink + React TUI for reading all GitHub pull request comments, including inline sub-threads.

It uses your existing `gh` authentication and calls `gh api` under the hood.

## What it reads

- PR discussion comments: `repos/<owner>/<repo>/issues/<pr>/comments`
- Inline review comments + replies: `repos/<owner>/<repo>/pulls/<pr>/comments`
- Reviews (APPROVED/CHANGES_REQUESTED/etc): `repos/<owner>/<repo>/pulls/<pr>/reviews`

All reads use `--paginate`.

## Install

```bash
npm install
npm link
```

## Install as `gh` extension

```bash
gh extension install jo-es/gh-reader
```

Run it as:

```bash
gh reader
```

## Run

```bash
ghr
```

Or use the local bin/script without linking:

```bash
./bin/ghr
npm run ghr
```

Options:

- `--pr <number>`: Force PR number.
- `--repo <owner/repo>`: Force repository.

## Inference behavior

By default `ghr` infers context with this order:

1. `gh repo view --json nameWithOwner` (fallback: parse `git remote origin`)
2. `gh pr view --json ...` (current branch PR)
3. open PR matching current branch (`gh pr list --head <branch>`)
4. most recently updated PR (any state) for current branch
5. most recently updated open PR fallback
6. most recently updated PR (any state) fallback

If a non-obvious fallback is used, `ghr` shows this in the UI and you can override with `--pr`.

## Keys

- `Tab`: switch focus between list and details panels
- `j`/`k` or up/down arrows: scroll focused panel
- `PgUp`/`PgDn`: page scroll focused panel
- `g`/`G`: jump to top/bottom of focused panel
- `h`/`l` or left/right arrows: switch tabs
- `1`/`2`/`3`: jump tabs
- mouse wheel: scroll hovered panel
- `q`: quit

## Display behavior

- All lists are sorted newest-first.
- Recent timestamps show relative time (for example `12min ago`), older items show date+time.
- Comment bodies render lightweight markdown styling (headings, bullets, links, inline code, emphasis).
- PR description is included in Discussion.
- Inline Threads and Details show PR context (`#<number> <title>`).
