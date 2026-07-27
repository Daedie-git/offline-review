import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { canonicalPath, isContained, sameCanonicalPath } from './safeFilesystem';
import { WorkspacePathStatus } from './types';

const STORAGE_PARTS = ['.vscode', 'local-reviews'];

export interface ResolvedWorkspacePath {
    readonly filePath: string;
    readonly absolutePath: string;
    readonly uri: vscode.Uri;
}

export class WorkspacePathResolver {
    readonly workspaceRoot: string;
    readonly canonicalRoot: string;

    constructor(workspaceRoot: string) {
        this.workspaceRoot = path.resolve(workspaceRoot);
        this.canonicalRoot = canonicalPath(this.workspaceRoot);
    }

    resolveUri(uri: vscode.Uri): ResolvedWorkspacePath | undefined {
        if (uri.scheme !== 'file') {
            return undefined;
        }
        const absolutePath = path.resolve(uri.fsPath);
        const filePath = this.relativePath(absolutePath);
        if (!filePath || !fs.existsSync(absolutePath)) {
            return undefined;
        }
        const canonical = this.safeCanonicalTarget(absolutePath, filePath);
        if (!canonical) {
            return undefined;
        }
        return { filePath, absolutePath: canonical, uri: vscode.Uri.file(canonical) };
    }

    normalizeStoredPath(filePath: string): string | undefined {
        if (!filePath || filePath.includes('\\') || path.posix.isAbsolute(filePath)) {
            return undefined;
        }
        const normalized = path.posix.normalize(filePath);
        if (normalized !== filePath
            || normalized === '.'
            || normalized === '..'
            || normalized.startsWith('../')
            || isExcludedPath(normalized)) {
            return undefined;
        }
        const absolutePath = path.resolve(this.workspaceRoot, ...normalized.split('/'));
        return this.relativePath(absolutePath) === normalized ? normalized : undefined;
    }

    inspectStoredPath(filePath: string): WorkspacePathStatus {
        const normalized = this.normalizeStoredPath(filePath);
        if (!normalized) {
            return 'unsafe';
        }
        const absolutePath = path.resolve(this.workspaceRoot, ...normalized.split('/'));
        if (!fs.existsSync(absolutePath)) {
            return this.hasSafeExistingAncestor(absolutePath, normalized) ? 'missing' : 'unsafe';
        }
        return this.safeCanonicalTarget(absolutePath, normalized) ? 'current' : 'unsafe';
    }

    uriForStoredPath(filePath: string): vscode.Uri | undefined {
        if (this.inspectStoredPath(filePath) !== 'current') {
            return undefined;
        }
        const absolutePath = path.resolve(this.workspaceRoot, ...filePath.split('/'));
        return vscode.Uri.file(canonicalPath(absolutePath));
    }

    private relativePath(absolutePath: string): string | undefined {
        const relative = path.relative(this.workspaceRoot, absolutePath);
        if (!relative
            || relative === '..'
            || relative.startsWith(`..${path.sep}`)
            || path.isAbsolute(relative)) {
            return undefined;
        }
        const normalized = relative.split(path.sep).join('/');
        return isExcludedPath(normalized) ? undefined : normalized;
    }

    private safeCanonicalTarget(absolutePath: string, filePath: string): string | undefined {
        try {
            const canonical = canonicalPath(absolutePath);
            const expected = path.join(this.canonicalRoot, ...filePath.split('/'));
            if (!isContained(this.canonicalRoot, canonical)
                || !sameCanonicalPath(canonical, expected)
                || this.hasNestedGitBoundary(absolutePath, this.workspaceRoot)
                || this.hasNestedGitBoundary(canonical, this.canonicalRoot)
                || isExcludedPath(this.canonicalRelative(canonical))) {
                return undefined;
            }
            return canonical;
        } catch {
            return undefined;
        }
    }

    private canonicalRelative(canonical: string): string {
        return path.relative(this.canonicalRoot, canonical).split(path.sep).join('/');
    }

    private hasNestedGitBoundary(absolutePath: string, root: string): boolean {
        let candidate = fs.existsSync(absolutePath) && fs.lstatSync(absolutePath).isDirectory()
            ? absolutePath
            : path.dirname(absolutePath);
        while (candidate !== root) {
            if (!isContained(root, candidate)) {
                return true;
            }
            if (fs.existsSync(path.join(candidate, '.git'))) {
                return true;
            }
            const parent = path.dirname(candidate);
            if (parent === candidate) {
                return true;
            }
            candidate = parent;
        }
        return false;
    }

    private hasSafeExistingAncestor(absolutePath: string, filePath: string): boolean {
        let candidate = path.dirname(absolutePath);
        while (!fs.existsSync(candidate)) {
            const parent = path.dirname(candidate);
            if (parent === candidate) {
                return false;
            }
            candidate = parent;
        }
        try {
            const canonical = canonicalPath(candidate);
            const relativeParts = filePath.split('/');
            const missingDepth = path.relative(candidate, absolutePath).split(path.sep).length;
            const expectedParts = relativeParts.slice(0, relativeParts.length - missingDepth);
            const expected = path.join(this.canonicalRoot, ...expectedParts);
            return isContained(this.canonicalRoot, canonical)
                && sameCanonicalPath(canonical, expected)
                && !this.hasNestedGitBoundary(candidate, this.workspaceRoot)
                && !this.hasNestedGitBoundary(canonical, this.canonicalRoot);
        } catch {
            return false;
        }
    }
}

function isExcludedPath(filePath: string): boolean {
    const parts = filePath.split('/');
    const lower = parts.map(part => part.toLocaleLowerCase('en-US'));
    return lower.includes('.git')
        || (lower[0] === STORAGE_PARTS[0] && lower[1] === STORAGE_PARTS[1]);
}
