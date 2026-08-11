# Offline Review

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://github.com/Daedie-git/offline-review/blob/HEAD/LICENSE)

Local code review and annotation for VS Code — no GitHub, no remote PR, no network.

Use **Offline Review** to inspect branch diffs and uncommitted work, leave inline comments that stay on disk, and annotate ordinary workspace files even when no review is open. Pair it with Copilot or other agents via `#offlineReviewComments` and `#offlineCodeComments`.

> [!NOTE]
> This project is a fork of [Gururagavendra/vscode-local-pr-reviewer](https://github.com/Gururagavendra/vscode-local-pr-reviewer). It preserves the original MIT license and copyright while publishing independently as `Daedie.offline-review`.

## Installation

### Marketplace

1. Open the Extensions panel (`Ctrl+Shift+X` / `Cmd+Shift+X`)
2. Search **Offline Review**
3. Click **Install**

Or from the Command Palette (`Ctrl+P` / `Cmd+P`):

```
ext install Daedie.offline-review
```

[VS Code Marketplace →](https://marketplace.visualstudio.com/items?itemName=Daedie.offline-review)

### From a VSIX

1. Download the latest `.vsix` from [GitHub Releases](https://github.com/Daedie-git/offline-review/releases)
2. Extensions → `...` → **Install from VSIX...**

## What you get

### Diff review (sidebar)

Open the **Offline Review** activity-bar icon. The sidebar has five panels:

| Panel | Purpose |
|---|---|
| **Branch Selector** | Pick a linked Git worktree, choose **Uncommitted** or **Active branch**, and set the base branch |
| **Changed Files** | Directory-grouped file tree with reviewed checkboxes, comment badges, commits list, and open-all-diffs |
| **Reviews** | Saved review sessions — create, activate, switch, or delete |
| **Review Comments** | All comments for the active review, grouped by file |
| **Code Comments** | Workspace editor comments (independent of any review) |

### Two review modes

- **Uncommitted** — diff the selected worktree’s `HEAD` against the working tree
- **Active branch** — diff that worktree’s checked-out branch against the base you choose

Worktree selection is session-only: the extension never switches your VS Code workspace. The open folder is labeled **Local** and is the default. Review metadata and comments always live under the original workspace’s `.vscode/offline-reviews/`.

### Inline review comments

- Comment on changed lines in the multi-diff / side-by-side diff editor
- Reply, edit, delete, resolve, and unresolve threads
- **Suggest a Change** with a live preview of the proposed edit
- Open the working-tree file from the changed-files list
- Extension-owned storage under `.vscode/offline-reviews/` is excluded from review diffs

### Workspace code comments

Annotate ordinary files in the open workspace **without** creating a review:

1. Open a regular file
2. Select a line or range
3. Use the editor gutter comment action

Threads show up under **Code Comments**. They are stored separately from review buckets and are not cleared when you delete reviews. Linked-worktree paths, virtual documents, paths outside the workspace, and storage files themselves are rejected on purpose.

### Safe re-anchoring

Review and workspace comments use the same conservative rule:

- If the original source still matches its authored range, the thread stays put
- If the exact line sequence moved once in the same file (and same review side), the thread is shown at the new range
- Zero matches → stale; multiple matches → ambiguous
- No fuzzy “nearest line” guesses, and no automatic rename following

Authored paths and ranges stay on disk; effective placement is computed for the current plan.

### Agents and Copilot

| Tool reference | What it returns |
|---|---|
| `#offlineReviewComments` | Active review / diff threads (optional file + resolved filters) |
| `#offlineCodeComments` | Workspace code-comment threads with path, anchors, and stale/missing status |

Both are local language-model tools — they do not call GitHub or any remote API.

## Getting started

1. Open a Git repository folder in VS Code
2. Click the **Offline Review** icon in the activity bar
3. In **Branch Selector**, confirm the worktree (**Local** is the open folder)
4. Choose **Uncommitted** or **Active branch** (set a base for branch mode)
5. Browse **Changed Files**, open diffs, and leave comments

### Multiple reviews

Each mode/worktree combination can become a saved session under **Reviews**. Activate one to restore its branches, files, and comment bucket. Clear or delete reviews without touching **Code Comments**.

## Storage

Everything is offline under the workspace:

```
.vscode/offline-reviews/
├── reviews/
│   └── <review-uuid>/
│       └── comments.json    # review/diff comments (schema v2)
└── workspace-comments.json  # ordinary-editor comments (schema v1)
```

## Performance

Comments are read from local disk, so agent queries stay local instead of round-tripping a remote PR API:

![Time comparison: remote API vs local storage](https://github.com/Daedie-git/offline-review/raw/HEAD/resources/graphs/time-comparison.png)

## Development

```bash
npm ci
npm run check
```

`npm run check` type-checks, lints, clean-builds `out/`, and runs tests. Prefer regenerating `out/` through the build rather than hand-editing generated files.
