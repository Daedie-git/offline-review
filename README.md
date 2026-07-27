# Offline Review

[![VS Code Marketplace](https://img.shields.io/visual-studio-marketplace/v/Daedie.offline-review?label=VS%20Code%20Marketplace&logo=visualstudiocode)](https://marketplace.visualstudio.com/items?itemName=Daedie.offline-review)
[![Installs](https://img.shields.io/visual-studio-marketplace/i/Daedie.offline-review)](https://marketplace.visualstudio.com/items?itemName=Daedie.offline-review)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://github.com/Daedie-git/offline-review/blob/HEAD/LICENSE)

A VS Code extension for local branch diff review with offline inline comments. Review your own code changes before pushing — no GitHub/remote needed.

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

- **Branch Diff View** - Select base and compare branches, see all changed files
- **Inline Comments** - Add, edit, delete comments on any line in the diff
- **Resolve/Unresolve** - Toggle comment threads as resolved with a single click
- **Tree Grouping** - Files grouped by directory with file count
- **Reviewed Checkbox** - Track which files you've reviewed
- **Comment Count Badge** - See comment count per file at a glance
- **Multi-diff Editor** - Open all changed files in one tabbed diff view
- **Suggest a Change** - Propose inline code changes with a live diff preview
- **Commits Section** - View commits between base and compare branches
- **Open File** - Quick action to open the working copy from the diff view
- **Multiple Reviews** - Save and switch between review sessions
- **Copilot Integration** - Query your review comments via Copilot chat using `#offlineReviewComments`
- **Persistent Storage** - Each review has an isolated UUID-backed comment bucket under `.vscode/local-reviews/`

## Performance

Offline Review comments are stored offline, making Copilot queries **36x faster** than fetching from GitHub API:

![Time Comparison: Remote API vs Local Storage](https://github.com/Daedie-git/offline-review/raw/HEAD/resources/graphs/time-comparison.png)

## Getting Started

1. Open a Git repository in VS Code
2. Click the **Offline Review** icon in the activity bar
3. Select a **Base** branch and a **Compare** branch
4. Browse changed files, open diffs, and add comments

## Architecture

```
User
 ├── Activity Bar (Offline Review sidebar)
 │    ├── Branch Selector  — pick base & compare branches
 │    ├── Changed Files    — grouped by directory, reviewed checkbox, comment badge
 │    ├── Comments Panel   — all threads & replies
 │    └── Saved Reviews    — switch between review sessions
 │
 └── Diff Editor           — inline comments via VS Code Comment API

Copilot Chat
 └── #offlineReviewComments  — query your review comments via LM Tool

Core Services
 ├── GitService       — branch list, file diffs, commit log
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
| `LocalReviewTool` | `src/tools/` | Copilot LM Tool — exposes comments to `#offlineReviewComments` chat queries |

## Development

```bash
npm ci
npm run check
```

`npm run check` type-checks and lints the canonical TypeScript, performs a clean rebuild of `out/`, and runs the integration tests. Generated JavaScript, declarations, and source maps should only be updated through the build.