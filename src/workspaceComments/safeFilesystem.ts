import * as fs from 'fs';
import * as path from 'path';

export function isContained(root: string, candidate: string): boolean {
    const relative = path.relative(root, candidate);
    return relative === ''
        || (relative !== '..'
            && !relative.startsWith(`..${path.sep}`)
            && !path.isAbsolute(relative));
}

export function sameCanonicalPath(left: string, right: string): boolean {
    return path.normalize(left) === path.normalize(right);
}

export function assertOrdinaryPath(pathToCheck: string, kind: 'file' | 'directory'): void {
    let stat: fs.Stats;
    try {
        stat = fs.lstatSync(pathToCheck);
    } catch (error: unknown) {
        throw new Error(`Cannot inspect ${pathToCheck}: ${errorMessage(error)}`);
    }
    if (stat.isSymbolicLink() || (kind === 'directory' ? !stat.isDirectory() : !stat.isFile())) {
        throw new Error(`Unsafe workspace comments ${kind}: ${pathToCheck}`);
    }
}

export function canonicalPath(pathToResolve: string): string {
    return fs.realpathSync.native(pathToResolve);
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
