# gh-reader (`ghr`)

Ink + React TUI for reading all GitHub pull request comments, including inline sub-threads.

It uses your existing `gh` authentication and calls `gh api` under the hood.

## What it reads

- PR discussion comments: `repos/<owner>/<repo>/issues/<pr>/comments`
- Inline review comments + replies: `repos/<owner>/<repo>/pulls/<pr>/comments`

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

- `--pr <number>`: Preselect a PR in the startup PR picker.
- `--repo <owner/repo>`: Force repository.

## Startup flow

By default `ghr` now starts on an open-PR selection screen:

1. `gh repo view --json nameWithOwner` (fallback: parse `git remote origin`)
2. list open PRs (`gh pr list --state open`)
3. select a PR and open the unified comments view

If `--pr` is provided and the PR is open, it is preselected in the picker.

## Keys

PR picker:
- `j`/`k` or up/down arrows: move selection
- `Enter`: open selected PR
- `r`: refresh open PR list
- `q`: quit

Comments view:
- `j`/`k` or up/down arrows: scroll focused panel
- `Tab`: switch focus between top list and bottom detail panel
- `PgUp`/`PgDn`: page scroll focused panel
- `g`/`G`: jump to top/bottom of focused panel
- `b`: return to PR picker
- `m`: toggle mouse capture (turn off to select/copy text with the terminal mouse)
- `q`: quit

## Display behavior

- Top panel shows one unified comments list:
  - discussion comments
  - inline thread roots with nested inline replies
- Inline replies are indented in the top list.
- The bottom panel shows full markdown-rendered body for the selected entry.
- Commit hashes in markdown bodies (for example `7b3aeaf`) are rendered as clickable GitHub commit links.
- Recent timestamps show relative time (for example `12min ago`), older items show date+time.
- Comment bodies render lightweight markdown styling (headings, bullets, links, inline code, emphasis).
- PR description is included in Discussion.
- Data auto-refreshes every 10 seconds; if a refresh fails, the last successful snapshot stays visible.
