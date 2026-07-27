"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.WorkspacePathResolver = void 0;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const vscode = __importStar(require("vscode"));
const safeFilesystem_1 = require("./safeFilesystem");
const STORAGE_PARTS = ['.vscode', 'local-reviews'];
class WorkspacePathResolver {
    constructor(workspaceRoot) {
        this.workspaceRoot = path.resolve(workspaceRoot);
        this.canonicalRoot = (0, safeFilesystem_1.canonicalPath)(this.workspaceRoot);
    }
    resolveUri(uri) {
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
    normalizeStoredPath(filePath) {
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
    inspectStoredPath(filePath) {
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
    uriForStoredPath(filePath) {
        if (this.inspectStoredPath(filePath) !== 'current') {
            return undefined;
        }
        const absolutePath = path.resolve(this.workspaceRoot, ...filePath.split('/'));
        return vscode.Uri.file((0, safeFilesystem_1.canonicalPath)(absolutePath));
    }
    relativePath(absolutePath) {
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
    safeCanonicalTarget(absolutePath, filePath) {
        try {
            const canonical = (0, safeFilesystem_1.canonicalPath)(absolutePath);
            const expected = path.join(this.canonicalRoot, ...filePath.split('/'));
            if (!(0, safeFilesystem_1.isContained)(this.canonicalRoot, canonical)
                || !(0, safeFilesystem_1.sameCanonicalPath)(canonical, expected)
                || this.hasNestedGitBoundary(absolutePath, this.workspaceRoot)
                || this.hasNestedGitBoundary(canonical, this.canonicalRoot)
                || isExcludedPath(this.canonicalRelative(canonical))) {
                return undefined;
            }
            return canonical;
        }
        catch {
            return undefined;
        }
    }
    canonicalRelative(canonical) {
        return path.relative(this.canonicalRoot, canonical).split(path.sep).join('/');
    }
    hasNestedGitBoundary(absolutePath, root) {
        let candidate = fs.existsSync(absolutePath) && fs.lstatSync(absolutePath).isDirectory()
            ? absolutePath
            : path.dirname(absolutePath);
        while (candidate !== root) {
            if (!(0, safeFilesystem_1.isContained)(root, candidate)) {
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
    hasSafeExistingAncestor(absolutePath, filePath) {
        let candidate = path.dirname(absolutePath);
        while (!fs.existsSync(candidate)) {
            const parent = path.dirname(candidate);
            if (parent === candidate) {
                return false;
            }
            candidate = parent;
        }
        try {
            const canonical = (0, safeFilesystem_1.canonicalPath)(candidate);
            const relativeParts = filePath.split('/');
            const missingDepth = path.relative(candidate, absolutePath).split(path.sep).length;
            const expectedParts = relativeParts.slice(0, relativeParts.length - missingDepth);
            const expected = path.join(this.canonicalRoot, ...expectedParts);
            return (0, safeFilesystem_1.isContained)(this.canonicalRoot, canonical)
                && (0, safeFilesystem_1.sameCanonicalPath)(canonical, expected)
                && !this.hasNestedGitBoundary(candidate, this.workspaceRoot)
                && !this.hasNestedGitBoundary(canonical, this.canonicalRoot);
        }
        catch {
            return false;
        }
    }
}
exports.WorkspacePathResolver = WorkspacePathResolver;
function isExcludedPath(filePath) {
    const parts = filePath.split('/');
    const lower = parts.map(part => part.toLocaleLowerCase('en-US'));
    return lower.includes('.git')
        || (lower[0] === STORAGE_PARTS[0] && lower[1] === STORAGE_PARTS[1]);
}
//# sourceMappingURL=pathResolver.js.map