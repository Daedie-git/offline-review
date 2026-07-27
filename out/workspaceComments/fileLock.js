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
exports.withFileLock = withFileLock;
const crypto = __importStar(require("crypto"));
const fs = __importStar(require("fs"));
const RETRY_MS = 25;
const TIMEOUT_MS = 1000;
const STALE_MS = 30000;
const sleeper = new Int32Array(new SharedArrayBuffer(4));
function withFileLock(lockPath, action, verifyDirectory = () => { }) {
    const acquired = acquire(lockPath, verifyDirectory);
    try {
        verifyDirectory();
        const result = action();
        verifyDirectory();
        return result;
    }
    finally {
        try {
            fs.closeSync(acquired.descriptor);
        }
        catch {
            // Best effort only after the protected action has completed.
        }
        releaseOwnedLock(lockPath, acquired.token);
    }
}
function acquire(lockPath, verifyDirectory) {
    const started = Date.now();
    while (true) {
        const token = crypto.randomUUID();
        let descriptor;
        try {
            verifyDirectory();
            descriptor = fs.openSync(lockPath, 'wx', 0o600);
            verifyDirectory();
            const record = { pid: process.pid, createdAt: Date.now(), token };
            fs.writeFileSync(descriptor, `${JSON.stringify(record)}\n`, 'utf8');
            // The lock is live coordination only. Comment-data crash durability is
            // established by the separate temporary/publication directory milestones.
            verifyDirectory();
            return { descriptor, token };
        }
        catch (error) {
            if (descriptor !== undefined) {
                try {
                    fs.closeSync(descriptor);
                }
                catch {
                    // Preserve the acquisition error.
                }
                removeOwnedLockAfterFailedAcquire(lockPath, token);
            }
            if (!isAlreadyExists(error)) {
                throw new Error(`Workspace comments lock could not be acquired: ${errorMessage(error)}`);
            }
            verifyDirectory();
            tryReclaimDeadStaleLock(lockPath);
            verifyDirectory();
            if (Date.now() - started >= TIMEOUT_MS) {
                throw new Error('Workspace comments are busy in another process; reload and try again');
            }
            Atomics.wait(sleeper, 0, 0, RETRY_MS);
        }
    }
}
function tryReclaimDeadStaleLock(lockPath) {
    const identity = inspectLockEntry(lockPath);
    if (!identity) {
        return;
    }
    const record = readLockRecord(lockPath);
    const reclaimable = record
        ? Date.now() - record.createdAt >= STALE_MS && isDemonstrablyDead(record.pid)
        : Date.now() - identity.mtimeMs >= STALE_MS;
    if (!reclaimable) {
        return;
    }
    const quarantinePath = uniqueQuarantinePath(lockPath);
    try {
        fs.renameSync(lockPath, quarantinePath);
    }
    catch (error) {
        if (isMissing(error)) {
            return;
        }
        throw error;
    }
    const quarantinedIdentity = inspectLockEntry(quarantinePath);
    const quarantinedRecord = record ? readLockRecord(quarantinePath) : undefined;
    if (quarantinedIdentity
        && sameLockEntry(identity, quarantinedIdentity)
        && (!record || quarantinedRecord?.token === record.token)) {
        unlinkBestEffort(quarantinePath);
        return;
    }
    restoreQuarantineWithoutOverwrite(quarantinePath, lockPath);
}
function releaseOwnedLock(lockPath, token) {
    const record = readLockRecord(lockPath);
    if (record?.token !== token) {
        return;
    }
    const quarantinePath = uniqueQuarantinePath(lockPath);
    try {
        fs.renameSync(lockPath, quarantinePath);
    }
    catch {
        return;
    }
    const quarantined = readLockRecord(quarantinePath);
    if (quarantined?.token === token) {
        unlinkBestEffort(quarantinePath);
        return;
    }
    restoreQuarantineWithoutOverwrite(quarantinePath, lockPath);
}
function removeOwnedLockAfterFailedAcquire(lockPath, token) {
    releaseOwnedLock(lockPath, token);
}
function restoreQuarantineWithoutOverwrite(quarantinePath, lockPath) {
    try {
        fs.linkSync(quarantinePath, lockPath);
        fs.unlinkSync(quarantinePath);
    }
    catch {
        // Preserve the quarantined record if another owner already has the lock.
    }
}
function readLockRecord(lockPath) {
    let value;
    try {
        const stat = fs.lstatSync(lockPath);
        if (stat.isSymbolicLink() || !stat.isFile()) {
            return undefined;
        }
        value = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    }
    catch {
        return undefined;
    }
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return undefined;
    }
    const candidate = value;
    if (Object.keys(candidate).length !== 3
        || !Object.prototype.hasOwnProperty.call(candidate, 'pid')
        || !Object.prototype.hasOwnProperty.call(candidate, 'createdAt')
        || !Object.prototype.hasOwnProperty.call(candidate, 'token')
        || typeof candidate.pid !== 'number'
        || !Number.isSafeInteger(candidate.pid)
        || candidate.pid <= 0
        || typeof candidate.createdAt !== 'number'
        || !Number.isFinite(candidate.createdAt)
        || candidate.createdAt < 0
        || typeof candidate.token !== 'string'
        || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(candidate.token)) {
        return undefined;
    }
    return candidate;
}
function isDemonstrablyDead(pid) {
    try {
        process.kill(pid, 0);
        return false;
    }
    catch (error) {
        return error instanceof Error && 'code' in error
            && error.code === 'ESRCH';
    }
}
function inspectLockEntry(lockPath) {
    try {
        const stat = fs.lstatSync(lockPath);
        if (stat.isSymbolicLink() || !stat.isFile()) {
            throw new Error(`Unsafe workspace comments lock: ${lockPath}`);
        }
        return { dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs };
    }
    catch (error) {
        if (isMissing(error)) {
            return undefined;
        }
        throw error;
    }
}
function sameLockEntry(before, after) {
    if (before.dev !== 0 && before.ino !== 0 && after.dev !== 0 && after.ino !== 0) {
        return before.dev === after.dev && before.ino === after.ino;
    }
    return before.size === after.size && before.mtimeMs === after.mtimeMs;
}
function uniqueQuarantinePath(lockPath) {
    return `${lockPath}.${process.pid}.${crypto.randomUUID()}.quarantine`;
}
function unlinkBestEffort(filePath) {
    try {
        fs.unlinkSync(filePath);
    }
    catch {
        // Best effort cleanup; an orphaned quarantine never acts as the lock.
    }
}
function isAlreadyExists(error) {
    return error instanceof Error && 'code' in error
        && error.code === 'EEXIST';
}
function isMissing(error) {
    return error instanceof Error && 'code' in error
        && error.code === 'ENOENT';
}
function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
//# sourceMappingURL=fileLock.js.map