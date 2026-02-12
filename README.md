# gh-feed (`gh feed`)

Ink + React TUI for reading GitHub pull request discussions/reviews in one threaded view, replying inline, and requesting Copilot review.

It uses your existing `gh` authentication and calls `gh api` under the hood.

## Terminal UI

<p align="center">
  <img src="https://github.com/user-attachments/assets/34e6ec27-8ea7-41bb-892e-669fc91fa45e" alt="gh-feed terminal UI showing the PR comments list and details panel" width="1100" />
</p>
<p align="center"><em>Two-pane terminal layout: threaded comments list on top, full detail/composer view below.</em></p>

## What it reads

- Repository identity: `gh repo view --json nameWithOwner` (fallback: `git remote origin`)
- Open PR list: `gh pr list --state open`
- PR issue resource (for PR description/body): `repos/<owner>/<repo>/issues/<pr>`
- PR discussion comments: `repos/<owner>/<repo>/issues/<pr>/comments`
- Inline review comments + replies: `repos/<owner>/<repo>/pulls/<pr>/comments`
- PR reviews: `repos/<owner>/<repo>/pulls/<pr>/reviews`
- Review request timeline events: `repos/<owner>/<repo>/issues/<pr>/timeline` (GraphQL fallback when REST timeline is unavailable)

Array reads use `--paginate`.

## What it writes

- Top-level PR comment: `repos/<owner>/<repo>/issues/<pr>/comments`
- Inline reply to inline comment: `repos/<owner>/<repo>/pulls/<pr>/comments/<comment_id>/replies`
- Reply to non-inline entries (discussion/review summary): posted as a PR discussion comment with a backlink to the target comment
- Request Copilot reviewer (fallback path): `repos/<owner>/<repo>/pulls/<pr>/requested_reviewers` with `reviewers[]=copilot-pull-request-reviewer[bot]`

For Copilot review requests, `gh-feed` tries `gh copilot-review` first (and auto-installs `ChrisCarini/gh-copilot-review` if missing), then verifies requested reviewers and falls back to REST when needed.

## Install

```bash
npm install
npm link
```

## Install as `gh` extension

```bash
gh extension install jo-es/gh-feed
```

If the extension is already installed, upgrade it with:

```bash
gh extension upgrade feed
```

Run it as:

```bash
gh feed
```

## Run

```bash
gh-feed
```

Or run through the GitHub CLI extension entrypoint:

```bash
gh feed
```

Or use the local bin/script without linking:

```bash
./bin/gh-feed
npm run gh-feed
```

Options:

- `--pr <number>`: Preselect a PR in the startup PR picker.
- `--repo <owner/repo>`: Force repository.

## Startup flow

By default `gh-feed` now starts on an open-PR selection screen:

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
- `Enter` on `Press Enter to add a new comment...`: open composer for a top-level comment
- `r`: reply to selected comment
- `c`: request review from Copilot Pull Request Reviewer
- `Tab`: switch focus between top list and bottom detail panel
- `PgUp`/`PgDn`: page scroll focused panel
- `g`/`G`: jump to top/bottom of focused panel
- `b`: return to PR picker
- `m`: toggle mouse capture (turn off to select/copy text with the terminal mouse)
- `q`: quit

Compose mode:
- Type to edit comment text in the bottom panel
- `Enter`: newline
- `Ctrl+S`: send
- `Esc`: cancel

Comments header action (mouse + keyboard):
- `[Copilot Review]` at the right side of the `Comments (...)` row requests Copilot review for the current PR

Detail action row (mouse + keyboard):
- `[Compose]` / `[Reply]`: open composer
- `[Send]` / `[Cancel]`: active while composing

## Display behavior

- Top panel shows one unified comments list:
  - `Press Enter to add a new comment...` row at the bottom for composing a top-level comment
  - discussion comments
  - inline thread roots with nested inline replies
  - review summary comments (APPROVED/COMMENTED/etc.)
  - system events for AI review workflow (for example, Copilot/Codex review requested/submitted)
- Inline threads linked to a review are nested under that review summary.
- Inline replies are indented in the top list.
- The bottom panel shows full markdown-rendered body for the selected entry.
- The bottom panel contains an action row for compose/reply/send/cancel actions.
- Commit hashes in markdown bodies (for example `7b3aeaf`) are rendered as clickable GitHub commit links.
- Recent timestamps show relative time (for example `12min ago`), older items show date+time.
- Comment bodies render lightweight markdown styling (headings, bullets, links, inline code, emphasis).
- PR description is included in Discussion.
- Data auto-refreshes every 30 seconds; if a refresh fails, the last successful snapshot stays visible.
