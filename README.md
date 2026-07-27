# Offline Review

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://github.com/Daedie-git/offline-review/blob/HEAD/LICENSE)

A VS Code extension for local branch diff review and ordinary-workspace code annotation with offline inline comments. Review or annotate code before pushing — no GitHub/remote needed.

> [!NOTE]
> This project is a fork of [Gururagavendra/vscode-local-pr-reviewer](https://github.com/Gururagavendra/vscode-local-pr-reviewer). It preserves the original MIT license and copyright while publishing the fork's changes independently as `Daedie.offline-review`. GitHub hosts this fork as an independent repository rather than as a member of the upstream fork network.

## Demo

![Offline Review in action](https://github.com/Daedie-git/offline-review/raw/HEAD/resources/screenshots/demo.gif)

## Installation

### Quick Install

1. Open VS Code
2. Open the Extensions panel (`Ctrl+Shift+X` / `Cmd+Shift+X`)
3. Search **"Offline Review"**
4. Click **Install**

### Via Command Palette

Press `Ctrl+P` (or `Cmd+P` on Mac) and run:
```
ext install Daedie.offline-review
```

### Via Marketplace

Install directly from the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=Daedie.offline-review)

### From a VSIX File

1. Download the latest `.vsix` from the [GitHub Releases](https://github.com/Daedie-git/offline-review/releases)
2. Open VS Code → Extensions → `...` menu → **Install from VSIX...**
3. Select the downloaded file

## Features

- **Linked Worktree Review** - Select any linked Git worktree without changing the open VS Code workspace
- **Two Review Modes** - Review the selected worktree's uncommitted changes or its active branch against a base
- **Branch Diff View** - Select a base branch and see all changed files on the active branch
- **Inline Comments** - Comment on modified lines and on the original side of deleted files
- **Resolve/Unresolve** - Toggle comment threads as resolved with a single click
- **Clean Working Diff** - Extension-owned `.vscode/local-reviews/` data is excluded from review results
- **Tree Grouping** - Files grouped by directory with file count
- **Reviewed Checkbox** - Track which files you've reviewed
- **Comment Count Badge** - See comment count per file at a glance
- **Multi-diff Editor** - Open all changed files in one tabbed diff view
- **Suggest a Change** - Propose inline code changes with a live diff preview
- **Commits Section** - View commits between base and compare branches
- **Open File** - Quick action to open the working copy from the diff view
- **Multiple Reviews** - Save and switch between review sessions
- **Workspace Code Comments** - Add persistent comments in ordinary editors without creating or activating a review
- **Copilot Integration** - Query diff comments with `#offlineReviewComments` and workspace comments with `#offlineCodeComments`
- **Independent Storage** - Reviews keep UUID-backed v2 buckets; workspace comments use one separate v1 file under `.vscode/local-reviews/`

## Performance

Offline Review comments are stored offline, making Copilot queries **36x faster** than fetching from GitHub API:

![Time Comparison: Remote API vs Local Storage](https://github.com/Daedie-git/offline-review/raw/HEAD/resources/graphs/time-comparison.png)

## Getting Started

1. Open a Git repository in VS Code
2. Click the **Offline Review** icon in the activity bar
3. Choose a linked **Git worktree** (the workspace checkout is **Local** and is selected by default on every activation)
4. Choose **Uncommitted** for that worktree's `HEAD` vs files, or **Active branch** for its checked-out branch vs the selected base
5. Browse changed files, open diffs, and add comments

Worktree selection is session-only: Offline Review never switches or opens a VS Code workspace and does not persist the selection. Review metadata and comments remain centralized under the original workspace's `.vscode/local-reviews/` directory.

### Workspace code comments

Open a regular file in the original Git workspace, select a line or range, and use the editor gutter's comment action. These threads appear in **Offline Review → Code Comments** even when no review is active. Linked-worktree files, virtual documents, files outside the workspace, symlink escapes, and `.vscode/local-reviews/` storage files are intentionally rejected.

Workspace threads are stored in `.vscode/local-reviews/workspace-comments.json` (schema v1), independently from review comments in `.vscode/local-reviews/reviews/<review UUID>/comments.json` (schema v2). **Clear Workspace Comments** affects only the workspace file; clearing or deleting reviews never affects it. Missing files remain listed, and changed source anchors are marked stale.

Use `#offlineCodeComments` to retrieve structured workspace threads with exact paths, ranges, anchors, and missing/stale status. A separate `address-code-comments` agent skill can be installed under `~/.agents/skills/address-code-comments/`; it lists unresolved threads and safely appends replies/resolves successfully addressed thread UUIDs without touching review buckets. The skill is intentionally installed outside this extension repository and is not included in the VSIX.

## Architecture

```
User
 ├── Activity Bar (Offline Review sidebar)
 │    ├── Branch Selector  — pick a linked worktree, review mode, and base branch
 │    ├── Changed Files    — grouped by directory, reviewed checkbox, comment badge
 │    ├── Review Comments  — persisted review comment buckets
 │    ├── Code Comments    — ordinary-editor threads grouped by file
 │    └── Saved Reviews    — switch between review sessions
 │
 ├── Diff Editor           — review comments via VS Code Comment API
 └── Regular Editor        — workspace code comments via a separate controller

Copilot Chat
 ├── #offlineReviewComments  — query review/diff comments
 └── #offlineCodeComments    — query independent workspace comments

Core Services
 ├── GitService       — linked worktree selection, branch list, file diffs, commit log
 ├── CommentController — create, edit, delete, resolve threads
 ├── LocalPrManager   — review CRUD, reviewed-file state
 └── StorageService   — read/write UUID-isolated JSON under .vscode/local-reviews/
```

### Key modules

| Module | Path | Responsibility |
|---|---|---|
| `extension.ts` | `src/` | Entry point — registers all views, commands, and event handlers |
| `GitService` | `src/git/` | Wraps VS Code Git API + `child_process` for diff, branch list, commits |
| `CommentController` | `src/comments/` | Manages all inline comment threads via the VS Code Comment API |
| `LocalPrManager` | `src/services/` | Review CRUD — create, load, save, delete, reviewed-file state |
| `StorageService` | `src/storage/` | Reads and writes UUID-isolated review JSON under `.vscode/local-reviews/` |
| `BranchSelectorWebviewProvider` | `src/views/` | WebviewView panel for branch selection |
| `ChangedFilesProvider` | `src/views/` | TreeView — directories + files with badges, checkboxes, open-file action |
| `LocalCommentsProvider` | `src/views/` | TreeView — flat list of all comment threads and replies |
| `LocalPrsProvider` | `src/views/` | TreeView — saved review sessions |
| `LocalReviewTool` | `src/tools/` | Copilot LM Tool — exposes review comments to `#offlineReviewComments` |
| Workspace comments modules | `src/workspaceComments/` | Safe paths, atomic v1 storage, ordinary-editor controller/view, and `#offlineCodeComments` |

## Development

```bash
npm ci
npm run check
```

`npm run check` type-checks and lints the canonical TypeScript, performs a clean rebuild of `out/`, and runs the integration tests. Generated JavaScript, declarations, and source maps should only be updated through the build.