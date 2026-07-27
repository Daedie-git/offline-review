'use strict';

const Module = require('node:module');
const path = require('node:path');

class Disposable {
    constructor(dispose = () => {}) {
        this._dispose = dispose;
    }

    dispose() {
        this._dispose();
    }
}

class EventEmitter {
    constructor() {
        this.listeners = new Set();
        this.event = listener => {
            this.listeners.add(listener);
            return new Disposable(() => this.listeners.delete(listener));
        };
    }

    fire(value) {
        for (const listener of this.listeners) {
            listener(value);
        }
    }

    dispose() {
        this.listeners.clear();
    }
}

class Uri {
    constructor({ scheme = 'file', authority = '', path: uriPath = '', query = '', fsPath } = {}) {
        this.scheme = scheme;
        this.authority = authority;
        this.path = uriPath;
        this.query = query;
        this.fsPath = fsPath ?? (scheme === 'file' ? uriPath : uriPath);
    }

    static from(parts) {
        return new Uri(parts);
    }

    static file(filePath) {
        const absolute = path.resolve(filePath);
        return new Uri({ scheme: 'file', path: absolute, fsPath: absolute });
    }

    static joinPath(base, ...parts) {
        return Uri.file(path.join(base.fsPath, ...parts));
    }

    static parse(value) {
        const parsed = new URL(value);
        return new Uri({
            scheme: parsed.protocol.slice(0, -1),
            authority: parsed.host,
            path: parsed.pathname,
            query: parsed.search.slice(1),
        });
    }

    toString() {
        const query = this.query ? `?${this.query}` : '';
        return `${this.scheme}://${this.authority}${this.path}${query}`;
    }
}

class Position {
    constructor(line, character) {
        this.line = line;
        this.character = character;
    }
}

class Range {
    constructor(startLine, startCharacter, endLine, endCharacter) {
        if (startLine instanceof Position && startCharacter instanceof Position) {
            this.start = startLine;
            this.end = startCharacter;
        } else {
            this.start = new Position(startLine, startCharacter);
            this.end = new Position(endLine, endCharacter);
        }
    }
}

class MarkdownString {
    constructor(value = '') {
        this.value = value;
    }
}

class LanguageModelTextPart {
    constructor(value) {
        this.value = value;
    }
}

class LanguageModelToolResult {
    constructor(content) {
        this.content = content;
    }
}

class TreeItem {
    constructor(label, collapsibleState = 0) {
        this.label = label;
        this.collapsibleState = collapsibleState;
    }
}

class ThemeIcon {
    constructor(id, color) {
        this.id = id;
        this.color = color;
    }
}
ThemeIcon.Folder = new ThemeIcon('folder');

class ThemeColor {
    constructor(id) {
        this.id = id;
    }
}

const createdCommentThreads = [];
const createdCommentControllers = [];

const vscode = {
    Disposable,
    EventEmitter,
    Uri,
    Position,
    Range,
    MarkdownString,
    LanguageModelTextPart,
    LanguageModelToolResult,
    TreeItem,
    ThemeIcon,
    ThemeColor,
    TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
    TreeItemCheckboxState: { Unchecked: 0, Checked: 1 },
    CommentMode: { Editing: 0, Preview: 1 },
    CommentThreadCollapsibleState: { Collapsed: 0, Expanded: 1 },
    CommentThreadState: { Unresolved: 0, Resolved: 1 },
    workspace: {
        workspaceFolders: [],
        textDocuments: [],
        asRelativePath(uri) {
            return uri.fsPath;
        },
    },
    comments: {
        createCommentController(id, label) {
            const controller = {
                id,
                label,
                options: undefined,
                commentingRangeProvider: undefined,
                createCommentThread(uri, range, comments) {
                    const thread = {
                        uri,
                        range,
                        comments,
                        disposed: false,
                        dispose() {
                            this.disposed = true;
                        },
                    };
                    createdCommentThreads.push(thread);
                    return thread;
                },
                dispose() {},
            };
            createdCommentControllers.push(controller);
            return controller;
        },
    },
    __createdCommentThreads: createdCommentThreads,
    __createdCommentControllers: createdCommentControllers,
    window: {
        showErrorMessage() {},
        showWarningMessage() {},
        showInformationMessage() {},
    },
    extensions: {
        getExtension() {
            return undefined;
        },
    },
};

let installed = false;
let originalLoad;

function installVscodeMock(workspaceRoot) {
    vscode.workspace.workspaceFolders = workspaceRoot
        ? [{ uri: Uri.file(workspaceRoot) }]
        : [];
    vscode.workspace.textDocuments = [];
    createdCommentThreads.length = 0;
    createdCommentControllers.length = 0;
    if (!installed) {
        originalLoad = Module._load;
        Module._load = function patchedLoad(request, parent, isMain) {
            if (request === 'vscode') {
                return vscode;
            }
            return originalLoad.call(this, request, parent, isMain);
        };
        installed = true;
    }
    return vscode;
}

module.exports = { installVscodeMock, vscode };
