'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { after, afterEach, test } = require('node:test');
const { installVscodeMock, vscode } = require('./helpers/vscodeMock');

const projectRoot = path.resolve(__dirname, '..');
const compiledRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'offline-code-comments-build-'));
execFileSync(path.join(projectRoot, 'node_modules', '.bin', 'tsc'), [
    '-p', projectRoot,
    '--outDir', compiledRoot,
    '--declaration', 'false',
    '--sourceMap', 'false',
], { cwd: projectRoot, stdio: 'pipe' });
const built = relativePath => require(path.join(compiledRoot, relativePath));

const temporaryDirectories = [];
after(() => fs.rmSync(compiledRoot, { recursive: true, force: true }));
afterEach(() => {
    while (temporaryDirectories.length) {
        fs.rmSync(temporaryDirectories.pop(), { recursive: true, force: true });
    }
});

function temporaryDirectory(prefix) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    temporaryDirectories.push(directory);
    return directory;
}

function write(root, relative, content) {
    const target = path.join(root, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content, 'utf8');
    return target;
}

function fixture() {
    const workspace = temporaryDirectory('offline-code-comments-');
    installVscodeMock(workspace);
    const { WorkspacePathResolver } = built('workspaceComments/pathResolver');
    const { WorkspaceCommentStorage } = built('workspaceComments/storage');
    const resolver = new WorkspacePathResolver(workspace);
    const storage = new WorkspaceCommentStorage(workspace, resolver);
    return { workspace, resolver, storage };
}

function document(filePath, content) {
    const lines = content.split('\n');
    return {
        uri: vscode.Uri.file(filePath),
        lineCount: lines.length,
        lineAt(line) {
            return {
                text: lines[line],
                range: { end: { character: lines[line].length } },
            };
        },
    };
}

test('workspace creation reuses exact open documents and validates cold fallback ownership', async () => {
    const { workspace, resolver, storage } = fixture();
    const filePath = write(workspace, 'src/create.ts', 'first\nsecond');
    const textDocument = document(filePath, 'first\nsecond');
    const { AuthorIdentity } = built('authorIdentity');
    const { WorkspaceCommentController } = built('workspaceComments/controller');
    const { addOrReplyWorkspaceComment } = built('extension');
    const controller = new WorkspaceCommentController(
        storage,
        resolver,
        new AuthorIdentity({ USERNAME: 'workspace-user' })
    );
    const pending = () => ({
        thread: {
            uri: textDocument.uri,
            range: new vscode.Range(0, 0, 0, 0),
            comments: [],
            dispose() {},
        },
        text: 'body',
    });

    let openCalls = 0;
    vscode.workspace.textDocuments = [textDocument];
    vscode.workspace.openTextDocument = async () => {
        openCalls++;
        return textDocument;
    };
    await addOrReplyWorkspaceComment(controller, pending());
    assert.equal(openCalls, 0, 'an exact warm workspace document is reused');

    vscode.workspace.textDocuments = [];
    await addOrReplyWorkspaceComment(controller, pending());
    assert.equal(openCalls, 1, 'a cold workspace document uses one fallback open');
    assert.deepEqual(
        storage.load().threads.flatMap(thread =>
            thread.comments.map(comment => comment.author)
        ),
        ['workspace-user', 'workspace-user']
    );

    vscode.workspace.openTextDocument = async () => {
        openCalls++;
        return document(path.join(workspace, 'src/other.ts'), 'other');
    };
    await assert.rejects(
        addOrReplyWorkspaceComment(controller, pending()),
        /document changed while it was opening/
    );
    assert.equal(storage.load().threads.length, 2, 'mismatched fallback cannot create a thread');
});

test('workspace path authorization rejects lexical and canonical aliases and Git/storage boundaries', () => {
    const { workspace, resolver } = fixture();
    const inside = write(workspace, 'src/inside.ts', 'inside\n');
    const outsideRoot = temporaryDirectory('offline-code-comments-outside-');
    const outside = write(outsideRoot, 'outside.ts', 'outside\n');
    const storageFile = write(
        workspace,
        '.vscode/local-reviews/workspace-comments.json',
        '{"version":1,"threads":[]}'
    );
    const escapedLink = path.join(workspace, 'src', 'escaped.ts');
    const insideLink = path.join(workspace, 'src', 'inside-alias.ts');
    fs.symlinkSync(outside, escapedLink);
    fs.symlinkSync(inside, insideLink);
    const nested = write(workspace, 'vendor/repo/file.ts', 'nested\n');
    fs.mkdirSync(path.join(workspace, 'vendor/repo/.git'));

    assert.equal(resolver.resolveUri(vscode.Uri.file(inside)).filePath, 'src/inside.ts');
    assert.equal(resolver.resolveUri(vscode.Uri.file(outside)), undefined);
    assert.equal(resolver.resolveUri(vscode.Uri.file(escapedLink)), undefined);
    assert.equal(resolver.resolveUri(vscode.Uri.file(insideLink)), undefined);
    assert.equal(resolver.resolveUri(vscode.Uri.file(nested)), undefined);
    assert.equal(resolver.resolveUri(vscode.Uri.parse('git-local-review:///src/inside.ts')), undefined);
    assert.equal(resolver.resolveUri(vscode.Uri.file(storageFile)), undefined);
    assert.equal(resolver.normalizeStoredPath('../outside.ts'), undefined);
    assert.equal(resolver.normalizeStoredPath('src/../outside.ts'), undefined);
    assert.equal(resolver.normalizeStoredPath('.vscode/local-reviews/other.json'), undefined);
    assert.equal(resolver.normalizeStoredPath('.VSCODE/LOCAL-REVIEWS/other.json'), undefined);
    assert.equal(resolver.normalizeStoredPath('.git/config'), undefined);

    fs.unlinkSync(inside);
    assert.equal(resolver.inspectStoredPath('src/inside.ts'), 'missing');
    assert.equal(resolver.inspectStoredPath('src/escaped.ts'), 'unsafe');
    assert.equal(resolver.inspectStoredPath('vendor/repo/file.ts'), 'unsafe');
});

test('storage rejects symlinked directories and workspace-comments file', () => {
    const outside = temporaryDirectory('offline-code-comments-storage-outside-');
    for (const component of ['.vscode', 'local-reviews', 'workspace-comments.json']) {
        const workspace = temporaryDirectory(`offline-code-comments-${component}-`);
        installVscodeMock(workspace);
        const { WorkspacePathResolver } = built('workspaceComments/pathResolver');
        const { WorkspaceCommentStorage } = built('workspaceComments/storage');
        const resolver = new WorkspacePathResolver(workspace);
        if (component === '.vscode') {
            fs.symlinkSync(outside, path.join(workspace, '.vscode'), 'dir');
        } else {
            fs.mkdirSync(path.join(workspace, '.vscode'));
            if (component === 'local-reviews') {
                fs.symlinkSync(outside, path.join(workspace, '.vscode/local-reviews'), 'dir');
            } else {
                fs.mkdirSync(path.join(workspace, '.vscode/local-reviews'));
                const target = write(outside, 'comments.json', '{"version":1,"threads":[]}');
                fs.symlinkSync(target, path.join(
                    workspace, '.vscode/local-reviews/workspace-comments.json'
                ));
            }
        }
        const storage = new WorkspaceCommentStorage(workspace, resolver);
        assert.throws(() => storage.load(), /Unsafe workspace comments/);
    }
});

test('fresh storage children are descriptor-bound and parent-synced before descent', () => {
    const workspace = temporaryDirectory('offline-code-comments-fresh-storage-');
    installVscodeMock(workspace);
    const { WorkspacePathResolver } = built('workspaceComments/pathResolver');
    const { WorkspaceCommentStorage } = built('workspaceComments/storage');
    const storage = new WorkspaceCommentStorage(workspace, new WorkspacePathResolver(workspace));
    write(workspace, 'src/fresh.ts', 'fresh\n');
    const originalMkdir = fs.mkdirSync;
    const originalFsync = fs.fsyncSync;
    const events = [];
    fs.mkdirSync = (directory, ...args) => {
        const result = originalMkdir(directory, ...args);
        const name = path.basename(String(directory));
        if (name === '.vscode' || name === 'local-reviews') {
            events.push(`mkdir:${name}`);
            assert.match(String(directory), /^\/proc\/self\/fd\/\d+\//);
        }
        return result;
    };
    fs.fsyncSync = descriptor => {
        if (fs.fstatSync(descriptor).isDirectory()) {
            events.push(`sync:${fs.readlinkSync(`/proc/self/fd/${descriptor}`)}`);
        }
        return originalFsync(descriptor);
    };
    try {
        storage.addThread('src/fresh.ts', 0, 0, 'fresh', 'comment', 'tester');
    } finally {
        fs.mkdirSync = originalMkdir;
        fs.fsyncSync = originalFsync;
    }
    const vscodeCreation = events.indexOf('mkdir:.vscode');
    const localReviewsCreation = events.indexOf('mkdir:local-reviews');
    assert.ok(vscodeCreation >= 0 && localReviewsCreation > vscodeCreation, events.join(','));
    assert.ok(
        events.slice(vscodeCreation + 1, localReviewsCreation).includes(`sync:${workspace}`),
        events.join(',')
    );
    assert.ok(
        events.slice(localReviewsCreation + 1).includes(`sync:${path.join(workspace, '.vscode')}`),
        events.join(',')
    );
});

test('parent fsync preflight failure prevents fresh child publication', () => {
    const workspace = temporaryDirectory('offline-code-comments-fresh-sync-failure-');
    installVscodeMock(workspace);
    const { WorkspacePathResolver } = built('workspaceComments/pathResolver');
    const { WorkspaceCommentStorage } = built('workspaceComments/storage');
    const storage = new WorkspaceCommentStorage(workspace, new WorkspacePathResolver(workspace));
    write(workspace, 'src/sync.ts', 'sync\n');
    const originalFsync = fs.fsyncSync;
    fs.fsyncSync = descriptor => {
        if (fs.fstatSync(descriptor).isDirectory()
            && fs.readlinkSync(`/proc/self/fd/${descriptor}`) === workspace) {
            const error = new Error('injected parent fsync failure');
            error.code = 'EIO';
            throw error;
        }
        return originalFsync(descriptor);
    };
    try {
        assert.throws(
            () => storage.addThread('src/sync.ts', 0, 0, 'sync', 'comment', 'tester'),
            /directory could not be synced/
        );
    } finally {
        fs.fsyncSync = originalFsync;
    }
    assert.equal(fs.existsSync(path.join(workspace, '.vscode')), false);
});

test('existing storage directories do not require parent fsync during read-only load', () => {
    const workspace = temporaryDirectory('offline-code-comments-existing-storage-');
    fs.mkdirSync(path.join(workspace, '.vscode/local-reviews'), { recursive: true });
    installVscodeMock(workspace);
    const { WorkspacePathResolver } = built('workspaceComments/pathResolver');
    const { WorkspaceCommentStorage } = built('workspaceComments/storage');
    const storage = new WorkspaceCommentStorage(workspace, new WorkspacePathResolver(workspace));
    const originalFsync = fs.fsyncSync;
    let directorySyncs = 0;
    fs.fsyncSync = descriptor => {
        if (fs.fstatSync(descriptor).isDirectory()) {
            directorySyncs++;
        }
        return originalFsync(descriptor);
    };
    try {
        assert.deepEqual(storage.load(), { version: 1, threads: [] });
    } finally {
        fs.fsyncSync = originalFsync;
    }
    assert.equal(directorySyncs, 0);
});

test('v1 storage persists atomically, reports stale/missing, and mutates by UUID', async () => {
    const { workspace, storage } = fixture();
    write(workspace, 'src/file.ts', 'first\nsecond\nthird\n');
    assert.equal(fs.existsSync(storage.filePath), false);

    const thread = storage.addThread('src/file.ts', 0, 1, 'first\nsecond', 'fix this', 'tester');
    assert.equal(fs.statSync(storage.filePath).mode & 0o777, 0o600);
    assert.deepEqual(
        fs.readdirSync(path.dirname(storage.filePath)).filter(name => name.endsWith('.tmp')),
        []
    );
    const reply = storage.addReply(thread.id, 'working', 'agent');
    assert.ok(reply.id);
    storage.editComment(thread.id, reply.id, 'done');
    storage.resolveThread(thread.id);
    assert.equal(storage.load().threads[0].comments[1].id, reply.id);
    assert.equal(storage.load().threads[0].state, 'resolved');
    assert.equal(storage.shouldIgnoreWatch(storage.filePath), true);

    write(workspace, 'src/file.ts', 'changed\nsecond\nthird\n');
    assert.equal(storage.getReports()[0].rangeStatus, 'stale');
    fs.unlinkSync(path.join(workspace, 'src/file.ts'));
    assert.equal(storage.getReports()[0].pathStatus, 'missing');

    const malformed = JSON.parse(fs.readFileSync(storage.filePath, 'utf8'));
    malformed.threads[0].unexpected = true;
    fs.writeFileSync(storage.filePath, JSON.stringify(malformed), 'utf8');
    assert.throws(() => storage.load(), /malformed|unsupported/);
    assert.throws(() => storage.clear(), /malformed|unsupported/);

    delete malformed.threads[0].unexpected;
    fs.writeFileSync(storage.filePath, JSON.stringify(malformed), 'utf8');
    await new Promise(resolve => setTimeout(resolve, 350));
    assert.equal(storage.shouldIgnoreWatch(storage.filePath), false);
    assert.equal(storage.deleteComment(thread.id, thread.comments[0].id), false);
    assert.equal(storage.deleteComment(thread.id, reply.id), true);
    assert.equal(fs.existsSync(storage.filePath), false);
});

test('cooperating lock and content fingerprint prevent lost updates', () => {
    const { workspace, storage } = fixture();
    write(workspace, 'src/lock.ts', 'locked\n');
    const thread = storage.addThread('src/lock.ts', 0, 0, 'locked', 'original', 'tester');

    fs.writeFileSync(storage.lockPath, 'other process\n');
    assert.throws(
        () => storage.resolveThread(thread.id),
        /busy in another process/
    );
    fs.unlinkSync(storage.lockPath);

    const originalFsync = fs.fsyncSync;
    let injected = false;
    fs.fsyncSync = descriptor => {
        originalFsync(descriptor);
        let descriptorPath = '';
        try {
            descriptorPath = fs.readlinkSync(`/proc/self/fd/${descriptor}`);
        } catch {
            // The test's mutation hook is Linux-specific, like the bound-path hardening it exercises.
        }
        if (!injected && descriptorPath.endsWith('.tmp')) {
            injected = true;
            const external = JSON.parse(fs.readFileSync(storage.filePath, 'utf8'));
            external.threads[0].comments[0].body = 'external writer';
            fs.writeFileSync(storage.filePath, `${JSON.stringify(external, null, 2)}\n`);
        }
    };
    try {
        assert.throws(
            () => storage.addReply(thread.id, 'must not overwrite', 'tester'),
            /changed outside the cooperating lock/
        );
    } finally {
        fs.fsyncSync = originalFsync;
    }
    assert.equal(storage.load().threads[0].comments[0].body, 'external writer');
    assert.equal(storage.load().threads[0].comments.length, 1);
});

test('old malformed locks are quarantined and recovered', () => {
    const directory = temporaryDirectory('offline-code-comments-malformed-old-lock-');
    const lockPath = path.join(directory, '.workspace-comments.lock');
    fs.writeFileSync(lockPath, 'not json\n', { mode: 0o600 });
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(lockPath, old, old);

    const { withFileLock } = built('workspaceComments/fileLock');
    let ran = false;
    withFileLock(lockPath, () => {
        ran = true;
    });
    assert.equal(ran, true);
    assert.equal(fs.existsSync(lockPath), false);
});

test('recent malformed locks remain busy', () => {
    const directory = temporaryDirectory('offline-code-comments-malformed-recent-lock-');
    const lockPath = path.join(directory, '.workspace-comments.lock');
    fs.writeFileSync(lockPath, 'not json\n', { mode: 0o600 });

    const { withFileLock } = built('workspaceComments/fileLock');
    assert.throws(() => withFileLock(lockPath, () => {}), /busy in another process/);
    assert.equal(fs.readFileSync(lockPath, 'utf8'), 'not json\n');
});

test('dead stale JSON locks are recovered', () => {
    const directory = temporaryDirectory('offline-code-comments-dead-lock-');
    const lockPath = path.join(directory, '.workspace-comments.lock');
    const deadPid = require('node:child_process').spawnSync(
        process.execPath, ['-e', 'process.exit(0)']
    ).pid;
    fs.writeFileSync(lockPath, `${JSON.stringify({
        pid: deadPid,
        createdAt: 0,
        token: '11111111-1111-4111-8111-111111111111',
    })}\n`);

    const { withFileLock } = built('workspaceComments/fileLock');
    let ran = false;
    withFileLock(lockPath, () => {
        ran = true;
    });
    assert.equal(ran, true);
    assert.equal(fs.existsSync(lockPath), false);
});

test('lock release does not delete a replacement owned by another token', () => {
    const directory = temporaryDirectory('offline-code-comments-token-lock-');
    const lockPath = path.join(directory, '.workspace-comments.lock');
    const replacement = {
        pid: process.pid,
        createdAt: Date.now(),
        token: '22222222-2222-4222-8222-222222222222',
    };
    const { withFileLock } = built('workspaceComments/fileLock');

    withFileLock(lockPath, () => {
        fs.unlinkSync(lockPath);
        fs.writeFileSync(lockPath, `${JSON.stringify(replacement)}\n`, { mode: 0o600 });
    });
    assert.deepEqual(JSON.parse(fs.readFileSync(lockPath, 'utf8')), replacement);
});

test('an absent canonical file is recovered from one valid displaced backup', () => {
    const { workspace, storage } = fixture();
    write(workspace, 'src/recovery.ts', 'recover\n');
    const thread = storage.addThread(
        'src/recovery.ts', 0, 0, 'recover', 'preserve after interrupted deletion', 'tester'
    );
    const directory = path.dirname(storage.filePath);
    const backupPath = path.join(directory, '.workspace-comments.json.crashed.backup');
    fs.renameSync(storage.filePath, backupPath);
    fs.writeFileSync(storage.lockPath, `${JSON.stringify({
        pid: process.pid,
        createdAt: Date.now(),
        token: '33333333-3333-4333-8333-333333333333',
    })}\n`, { mode: 0o600 });
    assert.throws(() => storage.load(), /busy in another process/);
    assert.equal(fs.existsSync(storage.filePath), false);
    assert.equal(fs.existsSync(backupPath), true);
    fs.unlinkSync(storage.lockPath);

    const recovered = storage.load();
    assert.equal(recovered.threads[0].id, thread.id);
    assert.equal(fs.existsSync(storage.filePath), true);
    assert.equal(fs.existsSync(backupPath), false);
});

test('a valid canonical wins over a valid leftover displacement backup', () => {
    const { workspace, storage } = fixture();
    write(workspace, 'src/coexist.ts', 'coexist\n');
    storage.addThread('src/coexist.ts', 0, 0, 'coexist', 'older', 'tester');
    const older = fs.readFileSync(storage.filePath);
    storage.addReply(storage.load().threads[0].id, 'newer canonical', 'tester');
    const backupPath = path.join(
        path.dirname(storage.filePath), '.workspace-comments.json.crashed.backup'
    );
    fs.writeFileSync(backupPath, older, { mode: 0o600 });

    const loaded = storage.load();
    assert.equal(loaded.threads[0].comments.length, 2);
    assert.equal(fs.existsSync(backupPath), false);
});

test('invalid scratch temporaries never block a valid canonical', () => {
    const { workspace, storage } = fixture();
    write(workspace, 'src/scratch-canonical.ts', 'canonical\n');
    const thread = storage.addThread(
        'src/scratch-canonical.ts', 0, 0, 'canonical', 'keep canonical', 'tester'
    );
    const directory = path.dirname(storage.filePath);
    const scratch = [
        ['.workspace-comments.json.dead-empty.tmp', Buffer.alloc(0)],
        ['.workspace-comments.json.dead-truncated.tmp', Buffer.from('{"version":1')],
        ['.workspace-comments.json.dead-utf8.tmp', Buffer.from([0xff, 0xfe, 0xfd])],
    ];
    for (const [name, contents] of scratch) {
        fs.writeFileSync(path.join(directory, name), contents, { mode: 0o600 });
    }

    const loaded = storage.load();
    assert.equal(loaded.threads[0].id, thread.id);
    for (const [name] of scratch) {
        assert.equal(fs.existsSync(path.join(directory, name)), false, name);
    }
});

test('invalid scratch temporaries are retired when no recoverable store exists', () => {
    const { storage } = fixture();
    assert.deepEqual(storage.load(), { version: 1, threads: [] });
    const directory = path.dirname(storage.filePath);
    fs.mkdirSync(directory, { recursive: true });
    const scratch = [
        ['.workspace-comments.json.dead-empty.tmp', Buffer.alloc(0)],
        ['.workspace-comments.json.dead-truncated.tmp', Buffer.from('{"threads":[')],
        ['.workspace-comments.json.dead-utf8.tmp', Buffer.from([0x7b, 0xff, 0x7d])],
    ];
    for (const [name, contents] of scratch) {
        fs.writeFileSync(path.join(directory, name), contents, { mode: 0o600 });
    }

    assert.deepEqual(storage.load(), { version: 1, threads: [] });
    assert.deepEqual(
        fs.readdirSync(directory).filter(name => name.endsWith('.tmp')),
        []
    );
});

test('invalid scratch temporaries do not block a valid displaced backup', () => {
    const { workspace, storage } = fixture();
    write(workspace, 'src/scratch-backup.ts', 'backup\n');
    const thread = storage.addThread(
        'src/scratch-backup.ts', 0, 0, 'backup', 'recover backup', 'tester'
    );
    const directory = path.dirname(storage.filePath);
    const backupPath = path.join(directory, '.workspace-comments.json.crashed.backup');
    const scratchPath = path.join(directory, '.workspace-comments.json.dead-empty.tmp');
    fs.renameSync(storage.filePath, backupPath);
    fs.writeFileSync(scratchPath, Buffer.alloc(0), { mode: 0o600 });

    const loaded = storage.load();
    assert.equal(loaded.threads[0].id, thread.id);
    assert.equal(fs.existsSync(backupPath), false);
    assert.equal(fs.existsSync(scratchPath), false);
});

test('malformed backups are preserved even when scratch temporaries are invalid', () => {
    const { workspace, storage } = fixture();
    write(workspace, 'src/malformed-backup.ts', 'canonical\n');
    storage.addThread(
        'src/malformed-backup.ts', 0, 0, 'canonical', 'valid canonical', 'tester'
    );
    const directory = path.dirname(storage.filePath);
    const backupPath = path.join(directory, '.workspace-comments.json.bad.backup');
    const scratchPath = path.join(directory, '.workspace-comments.json.dead-empty.tmp');
    fs.writeFileSync(backupPath, '{bad backup', { mode: 0o600 });
    fs.writeFileSync(scratchPath, Buffer.alloc(0), { mode: 0o600 });

    assert.throws(() => storage.load(), /could not be read|malformed|unsupported/);
    assert.equal(fs.existsSync(backupPath), true);
    assert.equal(fs.existsSync(scratchPath), true);
});

test('replacement publication syncs displacement, publication, and backup retirement in order', () => {
    const { workspace, storage } = fixture();
    write(workspace, 'src/durable.ts', 'durable\n');
    const thread = storage.addThread('src/durable.ts', 0, 0, 'durable', 'original', 'tester');
    const originalRename = fs.renameSync;
    const originalLink = fs.linkSync;
    const originalUnlink = fs.unlinkSync;
    const originalFsync = fs.fsyncSync;
    const events = [];
    let fsyncCount = 0;
    let hardLinkProbeCount = 0;
    const isDirectoryDescriptor = descriptor => {
        try {
            return fs.fstatSync(descriptor).isDirectory();
        } catch {
            return false;
        }
    };
    fs.renameSync = (oldPath, newPath) => {
        if (path.basename(String(oldPath)) === 'workspace-comments.json'
            && String(newPath).endsWith('.backup')) {
            events.push('displace');
        }
        return originalRename(oldPath, newPath);
    };
    fs.linkSync = (oldPath, newPath) => {
        if (String(newPath).endsWith('.link-probe.linked')) {
            hardLinkProbeCount++;
        }
        if (path.basename(String(newPath)) === 'workspace-comments.json') {
            events.push('publish');
        }
        return originalLink(oldPath, newPath);
    };
    fs.unlinkSync = filePath => {
        if (String(filePath).endsWith('.backup')) {
            events.push('retire');
        }
        return originalUnlink(filePath);
    };
    fs.fsyncSync = descriptor => {
        fsyncCount++;
        if (isDirectoryDescriptor(descriptor)) {
            events.push('dir-sync');
        }
        return originalFsync(descriptor);
    };
    try {
        storage.addReply(thread.id, 'replacement', 'tester');
    } finally {
        fs.renameSync = originalRename;
        fs.linkSync = originalLink;
        fs.unlinkSync = originalUnlink;
        fs.fsyncSync = originalFsync;
    }
    const displacement = events.indexOf('displace');
    const publication = events.indexOf('publish', displacement + 1);
    const retirement = events.indexOf('retire', publication + 1);
    assert.ok(events.slice(displacement + 1, publication).includes('dir-sync'), events.join(','));
    assert.ok(events.slice(publication + 1, retirement).includes('dir-sync'), events.join(','));
    assert.ok(events.slice(retirement + 1).includes('dir-sync'), events.join(','));
    assert.equal(fsyncCount, 5, 'warm replacement keeps one file and four directory barriers');
    assert.equal(events.filter(event => event === 'dir-sync').length, 4);
    assert.equal(hardLinkProbeCount, 0, 'successful hard-link capability is cached by directory');
});

test('directory replacement invalidates cached sync and hard-link capabilities', () => {
    const { workspace, storage } = fixture();
    write(workspace, 'src/replaced-capabilities.ts', 'capabilities\n');
    const thread = storage.addThread(
        'src/replaced-capabilities.ts', 0, 0, 'capabilities', 'original', 'tester'
    );
    const directory = path.dirname(storage.filePath);
    const displaced = `${directory}-old`;
    const canonical = fs.readFileSync(storage.filePath);
    fs.renameSync(directory, displaced);
    fs.mkdirSync(directory, { mode: 0o700 });
    fs.writeFileSync(storage.filePath, canonical, { mode: 0o600 });

    const originalFsync = fs.fsyncSync;
    const originalLink = fs.linkSync;
    let fsyncCount = 0;
    let hardLinkProbeCount = 0;
    fs.fsyncSync = descriptor => {
        fsyncCount++;
        return originalFsync(descriptor);
    };
    fs.linkSync = (oldPath, newPath) => {
        if (String(newPath).endsWith('.link-probe.linked')) {
            hardLinkProbeCount++;
        }
        return originalLink(oldPath, newPath);
    };
    try {
        storage.addReply(thread.id, 'new directory', 'tester');
    } finally {
        fs.fsyncSync = originalFsync;
        fs.linkSync = originalLink;
    }
    assert.equal(fsyncCount, 7, 'a new directory identity reruns both capability preflights');
    assert.equal(hardLinkProbeCount, 1);
});

test('warm temporary-name fsync failure leaves canonical and directory entries unchanged', () => {
    const { workspace, storage } = fixture();
    write(workspace, 'src/preflight-sync.ts', 'sync\n');
    const thread = storage.addThread(
        'src/preflight-sync.ts', 0, 0, 'sync', 'original', 'tester'
    );
    const directory = path.dirname(storage.filePath);
    const originalStore = fs.readFileSync(storage.filePath);
    const originalEntries = fs.readdirSync(directory).sort();
    const originalFsync = fs.fsyncSync;
    fs.fsyncSync = descriptor => {
        if (fs.fstatSync(descriptor).isDirectory()) {
            const error = new Error('injected directory fsync failure');
            error.code = 'EIO';
            throw error;
        }
        return originalFsync(descriptor);
    };
    try {
        assert.throws(
            () => storage.addReply(thread.id, 'must not start', 'tester'),
            /directory could not be synced/
        );
    } finally {
        fs.fsyncSync = originalFsync;
    }
    assert.deepEqual(fs.readFileSync(storage.filePath), originalStore);
    assert.deepEqual(fs.readdirSync(directory).sort(), originalEntries);
});

test('directory fsync failure after displacement or publication preserves recovery entries', () => {
    for (const stage of ['displacement', 'publication']) {
        const { workspace, storage } = fixture();
        write(workspace, `src/sync-${stage}.ts`, `${stage}\n`);
        const thread = storage.addThread(
            `src/sync-${stage}.ts`, 0, 0, stage, 'original', 'tester'
        );
        const originalRename = fs.renameSync;
        const originalLink = fs.linkSync;
        const originalFsync = fs.fsyncSync;
        let failNextDirectorySync = false;
        let injected = false;
        fs.renameSync = (oldPath, newPath) => {
            const result = originalRename(oldPath, newPath);
            if (stage === 'displacement'
                && path.basename(String(oldPath)) === 'workspace-comments.json'
                && String(newPath).endsWith('.backup')) {
                failNextDirectorySync = true;
            }
            return result;
        };
        fs.linkSync = (oldPath, newPath) => {
            const result = originalLink(oldPath, newPath);
            if (stage === 'publication'
                && path.basename(String(newPath)) === 'workspace-comments.json'
                && String(oldPath).endsWith('.tmp')) {
                failNextDirectorySync = true;
            }
            return result;
        };
        fs.fsyncSync = descriptor => {
            if (failNextDirectorySync && fs.fstatSync(descriptor).isDirectory()) {
                failNextDirectorySync = false;
                injected = true;
                const error = new Error(`injected ${stage} sync failure`);
                error.code = 'EIO';
                throw error;
            }
            return originalFsync(descriptor);
        };
        try {
            assert.throws(
                () => storage.addReply(thread.id, 'new publication', 'tester'),
                /directory could not be synced/
            );
        } finally {
            fs.renameSync = originalRename;
            fs.linkSync = originalLink;
            fs.fsyncSync = originalFsync;
        }
        assert.equal(injected, true, stage);
        const entries = fs.readdirSync(path.dirname(storage.filePath));
        assert.equal(entries.some(name => name.endsWith('.backup')), true, stage);
        assert.equal(entries.some(name => name.endsWith('.tmp')), true, stage);
        assert.equal(fs.existsSync(storage.filePath), stage === 'publication', stage);
        const recovered = storage.load();
        assert.equal(
            recovered.threads[0].comments.length,
            stage === 'publication' ? 2 : 1,
            stage
        );
    }
});

test('failed first-publication sync recovers from its durable temporary', () => {
    const { workspace, storage } = fixture();
    write(workspace, 'src/first-publication.ts', 'first\n');
    const originalLink = fs.linkSync;
    const originalFsync = fs.fsyncSync;
    let failPublicationSync = false;
    fs.linkSync = (oldPath, newPath) => {
        const result = originalLink(oldPath, newPath);
        if (path.basename(String(newPath)) === 'workspace-comments.json'
            && String(oldPath).endsWith('.tmp')) {
            failPublicationSync = true;
        }
        return result;
    };
    fs.fsyncSync = descriptor => {
        if (failPublicationSync && fs.fstatSync(descriptor).isDirectory()) {
            failPublicationSync = false;
            const error = new Error('injected first-publication sync failure');
            error.code = 'EIO';
            throw error;
        }
        return originalFsync(descriptor);
    };
    try {
        assert.throws(
            () => storage.addThread(
                'src/first-publication.ts', 0, 0, 'first', 'recover me', 'tester'
            ),
            /directory could not be synced/
        );
    } finally {
        fs.linkSync = originalLink;
        fs.fsyncSync = originalFsync;
    }
    const directory = path.dirname(storage.filePath);
    assert.equal(fs.existsSync(storage.filePath), true);
    assert.equal(fs.readdirSync(directory).some(name => name.endsWith('.tmp')), true);

    // Model the failed publication name not surviving a crash. The durable temporary remains.
    fs.unlinkSync(storage.filePath);
    const recovered = storage.load();
    assert.equal(recovered.threads.length, 1);
    assert.equal(recovered.threads[0].comments[0].body, 'recover me');
    assert.equal(fs.readdirSync(directory).some(name => name.endsWith('.tmp')), false);
});

test('storage fails closed before mutation when descriptor-bound paths are unavailable', () => {
    const { workspace, storage } = fixture();
    write(workspace, 'src/no-proc.ts', 'bound\n');
    const thread = storage.addThread('src/no-proc.ts', 0, 0, 'bound', 'original', 'tester');
    const directory = path.dirname(storage.filePath);
    const originalStore = fs.readFileSync(storage.filePath);
    const originalEntries = fs.readdirSync(directory).sort();
    const originalStat = fs.statSync;
    fs.statSync = (filePath, ...args) => {
        if (String(filePath).startsWith('/proc/self/fd/')) {
            const error = new Error('descriptor path unavailable');
            error.code = 'ENOENT';
            throw error;
        }
        return originalStat(filePath, ...args);
    };
    try {
        assert.throws(
            () => storage.addReply(thread.id, 'must fail closed', 'tester'),
            /requires a verified descriptor-bound path/
        );
    } finally {
        fs.statSync = originalStat;
    }
    assert.deepEqual(fs.readFileSync(storage.filePath), originalStore);
    assert.deepEqual(fs.readdirSync(directory).sort(), originalEntries);
});

test('directory replacement around sensitive stages never changes the replacement store', () => {
    for (const stage of ['lock', 'temporary', 'displacement', 'publication']) {
        const { workspace, storage } = fixture();
        write(workspace, `src/${stage}.ts`, `${stage}\n`);
        const thread = storage.addThread(
            `src/${stage}.ts`, 0, 0, stage, 'original', 'tester'
        );
        const directory = path.dirname(storage.filePath);
        const displacedDirectory = path.join(path.dirname(directory), `original-${stage}`);
        const originalStore = fs.readFileSync(storage.filePath);
        const replacementStore = Buffer.from(originalStore);
        const sentinel = Buffer.from(`external-${stage}\n`);
        let replaced = false;
        const replaceDirectory = () => {
            if (replaced) {
                return;
            }
            replaced = true;
            fs.renameSync(directory, displacedDirectory);
            fs.mkdirSync(directory);
            fs.writeFileSync(storage.filePath, replacementStore, { mode: 0o600 });
            fs.writeFileSync(path.join(directory, 'sentinel'), sentinel);
        };
        const originalOpen = fs.openSync;
        const originalRename = fs.renameSync;
        const originalLink = fs.linkSync;
        fs.openSync = (filePath, ...args) => {
            const name = path.basename(String(filePath));
            if ((stage === 'lock' && name === '.workspace-comments.lock')
                || (stage === 'temporary' && name.endsWith('.tmp'))) {
                replaceDirectory();
            }
            return originalOpen(filePath, ...args);
        };
        fs.renameSync = (oldPath, newPath) => {
            if (stage === 'displacement'
                && path.basename(String(oldPath)) === 'workspace-comments.json'
                && String(newPath).endsWith('.backup')) {
                replaceDirectory();
            }
            return originalRename(oldPath, newPath);
        };
        fs.linkSync = (oldPath, newPath) => {
            if (stage === 'publication'
                && path.basename(String(newPath)) === 'workspace-comments.json'
                && String(oldPath).endsWith('.tmp')) {
                replaceDirectory();
            }
            return originalLink(oldPath, newPath);
        };
        try {
            assert.throws(
                () => storage.addReply(thread.id, 'must fail safely', 'tester'),
                /storage changed unexpectedly/
            );
        } finally {
            fs.openSync = originalOpen;
            fs.renameSync = originalRename;
            fs.linkSync = originalLink;
        }
        assert.equal(replaced, true, stage);
        assert.deepEqual(fs.readFileSync(storage.filePath), replacementStore, stage);
        assert.deepEqual(fs.readFileSync(path.join(directory, 'sentinel')), sentinel, stage);
        assert.deepEqual(fs.readdirSync(directory).sort(), ['sentinel', 'workspace-comments.json'], stage);
    }
});

test('unsupported hard links reject a cold storage session before canonical displacement', () => {
    const { workspace, resolver, storage } = fixture();
    write(workspace, 'src/no-links.ts', 'links\n');
    const thread = storage.addThread('src/no-links.ts', 0, 0, 'links', 'original', 'tester');
    const { WorkspaceCommentStorage } = built('workspaceComments/storage');
    const coldStorage = new WorkspaceCommentStorage(workspace, resolver);
    const original = fs.readFileSync(storage.filePath);
    const originalLink = fs.linkSync;
    const originalRename = fs.renameSync;
    let canonicalDisplaced = false;
    fs.linkSync = (existingPath, newPath) => {
        if (String(newPath).endsWith('.link-probe.linked')) {
            const error = new Error('hard links unsupported');
            error.code = 'ENOTSUP';
            throw error;
        }
        return originalLink(existingPath, newPath);
    };
    fs.renameSync = (oldPath, newPath) => {
        if (oldPath === storage.filePath && String(newPath).endsWith('.backup')) {
            canonicalDisplaced = true;
        }
        return originalRename(oldPath, newPath);
    };
    try {
        assert.throws(
            () => coldStorage.addReply(thread.id, 'must not move canonical', 'tester'),
            /does not support safe hard-link publication/
        );
    } finally {
        fs.linkSync = originalLink;
        fs.renameSync = originalRename;
    }
    assert.equal(canonicalDisplaced, false);
    assert.deepEqual(fs.readFileSync(storage.filePath), original);
});

test('warm publication link failure preserves durable temporary and backup', () => {
    const { workspace, storage } = fixture();
    write(workspace, 'src/link-failure.ts', 'link\n');
    const thread = storage.addThread(
        'src/link-failure.ts', 0, 0, 'link', 'original', 'tester'
    );
    const originalLink = fs.linkSync;
    fs.linkSync = (oldPath, newPath) => {
        if (path.basename(String(newPath)) === path.basename(storage.filePath)
            && String(oldPath).endsWith('.tmp')) {
            const error = new Error('injected publication link failure');
            error.code = 'EIO';
            throw error;
        }
        return originalLink(oldPath, newPath);
    };
    try {
        assert.throws(
            () => storage.addReply(thread.id, 'not published', 'tester'),
            /publication link failure/
        );
    } finally {
        fs.linkSync = originalLink;
    }
    const entries = fs.readdirSync(path.dirname(storage.filePath));
    assert.equal(entries.some(name => name.endsWith('.backup')), true);
    assert.equal(entries.some(name => name.endsWith('.tmp')), true);
    assert.equal(fs.existsSync(storage.filePath), false);
    assert.equal(storage.load().threads[0].comments.length, 1);
});

test('external atomic replacement after displacement is never overwritten', () => {
    const { workspace, storage } = fixture();
    write(workspace, 'src/atomic.ts', 'atomic\n');
    const thread = storage.addThread('src/atomic.ts', 0, 0, 'atomic', 'original', 'tester');
    const external = storage.load();
    external.threads[0].comments[0].body = 'external atomic writer';
    const externalSerialized = `${JSON.stringify(external, null, 2)}\n`;
    const originalLink = fs.linkSync;
    let injected = false;
    fs.linkSync = (existingPath, newPath) => {
        if (!injected
            && path.basename(String(newPath)) === path.basename(storage.filePath)
            && String(existingPath).endsWith('.tmp')) {
            injected = true;
            const externalTemporary = path.join(path.dirname(storage.filePath), '.external.tmp');
            fs.writeFileSync(externalTemporary, externalSerialized, { mode: 0o600 });
            fs.renameSync(externalTemporary, storage.filePath);
        }
        return originalLink(existingPath, newPath);
    };
    try {
        assert.throws(
            () => storage.addReply(thread.id, 'must not overwrite', 'tester'),
            /changed outside the cooperating lock/
        );
    } finally {
        fs.linkSync = originalLink;
    }
    assert.equal(fs.readFileSync(storage.filePath, 'utf8'), externalSerialized);
    assert.equal(
        fs.readdirSync(path.dirname(storage.filePath)).some(name => name.endsWith('.backup')),
        true,
        'the displaced original remains preserved until the valid canonical is recovered'
    );
    assert.equal(storage.load().threads[0].comments.length, 1);
    assert.equal(
        fs.readdirSync(path.dirname(storage.filePath)).some(name => name.endsWith('.backup')),
        false,
        'recovery keeps the valid newer canonical and retires the validated older backup'
    );
});

test('reports distinguish shortened ranges and preserve CRLF terminal blank-line anchors', () => {
    const { workspace, storage } = fixture();
    write(workspace, 'src/short.ts', 'first\nsecond\n');
    storage.addThread('src/short.ts', 1, 1, 'second', 'short range', 'tester');
    write(workspace, 'src/short.ts', 'first');
    const report = storage.getReports()[0];
    assert.equal(report.pathStatus, 'current');
    assert.equal(report.anchorStatus, 'notFound');
    assert.equal(report.rangeStatus, 'stale');
    assert.equal(report.stale, true);

    const crlfFile = write(workspace, 'src/crlf.ts', 'first\r\n\r\n');
    const blank = storage.addThread('src/crlf.ts', 2, 2, '', 'terminal blank', 'tester');
    const blankReport = storage.getReports().find(candidate => candidate.id === blank.id);
    assert.equal(blankReport.rangeStatus, 'current');
    assert.equal(fs.readFileSync(crlfFile, 'utf8'), 'first\r\n\r\n');
});

test('controller skips invalid ranges, recreates moved IDs, and fails stale mutations', () => {
    const { workspace, resolver, storage } = fixture();
    const first = write(workspace, 'src/first.ts', 'alpha\nbeta\n');
    const second = write(workspace, 'src/second.ts', 'moved\n');
    const saved = storage.addThread('src/first.ts', 0, 0, 'alpha', 'move me', 'tester');
    const { WorkspaceCommentController } = built('workspaceComments/controller');
    const controller = new WorkspaceCommentController(storage, resolver);
    controller.loadAllThreads();
    const originalThread = vscode.__createdCommentThreads.at(-1);
    assert.equal(originalThread.uri.fsPath, first);

    const external = storage.load();
    external.threads[0].filePath = 'src/second.ts';
    external.threads[0].startLine = 0;
    external.threads[0].endLine = 0;
    external.threads[0].sourceAnchor = 'moved';
    fs.writeFileSync(storage.filePath, `${JSON.stringify(external, null, 2)}\n`);
    controller.loadAllThreads();
    const movedThread = vscode.__createdCommentThreads.at(-1);
    assert.equal(originalThread.disposed, true);
    assert.equal(movedThread.uri.fsPath, second);

    const removed = storage.load();
    removed.threads = [];
    fs.unlinkSync(storage.filePath);
    assert.throws(() => controller.resolveThread(movedThread), /stale or missing/);

    const invalid = storage.addThread('src/second.ts', 0, 0, 'moved', 'invalid later', 'tester');
    const invalidData = storage.load();
    invalidData.threads.find(item => item.id === invalid.id).startLine = 5;
    invalidData.threads.find(item => item.id === invalid.id).endLine = 5;
    fs.writeFileSync(storage.filePath, `${JSON.stringify(invalidData, null, 2)}\n`);
    controller.loadAllThreads();
    const reanchored = vscode.__createdCommentThreads.find(
        thread => thread.__workspaceThreadId === invalid.id
    );
    assert.equal(reanchored.range.start.line, 0);
    assert.equal(reanchored.range.end.line, 0);
    controller.dispose();
    void saved;
});

test('ordinary-editor controller and provider support healthy workspace comments', () => {
    const { workspace, resolver, storage } = fixture();
    const filePath = write(workspace, 'src/controller.ts', 'alpha\nbeta\n');
    const { WorkspaceCommentController } = built('workspaceComments/controller');
    const { WorkspaceCommentsProvider, CodeCommentThreadItem } = built('workspaceComments/provider');
    const controller = new WorkspaceCommentController(storage, resolver);
    const vscodeController = vscode.__createdCommentControllers.at(-1);
    assert.equal(vscodeController.id, 'localCodeComments');
    assert.equal(vscodeController.commentingRangeProviderAssignments, 1);
    const initialRangeProvider = vscodeController.commentingRangeProvider;
    controller.refreshCommentingRanges();
    assert.equal(vscodeController.commentingRangeProviderAssignments, 2);
    assert.equal(vscodeController.commentingRangeProvider, initialRangeProvider);
    const textDocument = document(filePath, 'alpha\nbeta\n');
    assert.equal(
        controller.controller.commentingRangeProvider.provideCommentingRanges(textDocument).length,
        1
    );
    assert.equal(
        controller.controller.commentingRangeProvider.provideCommentingRanges(
            { ...textDocument, uri: vscode.Uri.parse('git-local-review:///src/controller.ts') }
        ).length,
        0
    );

    controller.createThread(textDocument, new vscode.Range(0, 0, 1, 0), 'ordinary comment');
    const renderedThread = vscode.__createdCommentThreads.at(-1);
    const savedId = storage.load().threads[0].id;
    assert.equal(storage.load().threads[0].sourceAnchor, 'alpha\nbeta');
    controller.addReply(renderedThread, 'reply after an unrelated review transition');
    const replyComment = renderedThread.comments[1];
    controller.saveEditedComment(renderedThread, replyComment, 'edited by stable UUID');
    controller.resolveThread(renderedThread);
    controller.loadAllThreads();
    assert.equal(storage.load().threads[0].id, savedId);
    assert.equal(storage.load().threads[0].comments[1].body, 'edited by stable UUID');
    assert.equal(storage.load().threads[0].state, 'resolved');

    const provider = new WorkspaceCommentsProvider(storage, resolver);
    const fileItems = provider.getChildren();
    assert.equal(fileItems.length, 1);
    const threadItems = provider.getChildren(fileItems[0]);
    assert.equal(threadItems[0] instanceof CodeCommentThreadItem, true);
    assert.equal(threadItems[0].command.command, 'localPrReview.openCodeComment');
    fs.unlinkSync(filePath);
    provider.refresh();
    const missingItem = provider.getChildren(provider.getChildren()[0])[0];
    assert.match(missingItem.description, /missing/);
    assert.equal(missingItem.command, undefined);

    controller.loadAllThreads();
    assert.equal(renderedThread.disposed, true);
    assert.equal(storage.load().threads.length, 1, 'missing threads stay persisted');
    provider.dispose();
    controller.dispose();
});

test('workspace tree uses one report snapshot per refresh generation', () => {
    const { workspace, resolver, storage } = fixture();
    write(workspace, 'src/a.ts', 'a\n');
    write(workspace, 'src/b.ts', 'b\n');
    storage.addThread('src/a.ts', 0, 0, 'a', 'A', 'tester');
    storage.addThread('src/b.ts', 0, 0, 'b', 'B', 'tester');
    const originalGetReports = storage.getReports.bind(storage);
    let reportCalls = 0;
    storage.getReports = () => {
        reportCalls++;
        return originalGetReports();
    };

    const { WorkspaceCommentsProvider } = built('workspaceComments/provider');
    const provider = new WorkspaceCommentsProvider(storage, resolver);
    const roots = provider.getChildren();
    assert.equal(roots.length, 2);
    assert.equal(reportCalls, 1);
    for (const root of roots) {
        assert.equal(provider.getChildren(root).length, 1);
    }
    provider.getChildren();
    assert.equal(reportCalls, 1, 'root and every expanded file share one snapshot');

    provider.refresh();
    provider.getChildren();
    assert.equal(reportCalls, 2, 'refresh invalidates exactly one provider generation');
});

test('code-comments tool filters safely without review-bucket changes', async () => {
    const { workspace, resolver, storage } = fixture();
    write(workspace, 'src/tool.ts', 'const value = 1;\n');
    const thread = storage.addThread(
        'src/tool.ts', 0, 0, 'const value = 1;', 'rename value', 'tester'
    );
    write(workspace, '.vscode/local-reviews/reviews/review-id/comments.json', '{"version":2}\n');
    const reviewBucket = path.join(
        workspace, '.vscode/local-reviews/reviews/review-id/comments.json'
    );
    const reviewBefore = fs.readFileSync(reviewBucket, 'utf8');

    const { WorkspaceCommentsTool } = built('workspaceComments/tool');
    const tool = new WorkspaceCommentsTool(storage, resolver);
    const result = await tool.invoke({ input: {
        filePath: 'src/tool.ts', state: 'unresolved',
    } }, undefined);
    const payload = JSON.parse(result.content[0].value);
    assert.equal(payload.matchedThreads, 1);
    assert.equal(payload.threads[0].id, thread.id);
    assert.equal(payload.threads[0].missing, false);
    assert.equal(payload.threads[0].rangeStatus, 'current');
    const invalid = await tool.invoke({ input: { filePath: '../tool.ts' } }, undefined);
    assert.match(invalid.content[0].value, /normalized path/);
    assert.equal(fs.readFileSync(reviewBucket, 'utf8'), reviewBefore);
});

test('workspace exact projections are read-only, cached, and hide stale or ambiguous inline threads', async () => {
    const { workspace, resolver, storage } = fixture();
    const movedPath = write(workspace, 'src/moved.ts', 'before\nneedle\nafter\n');
    write(workspace, 'src/ambiguous.ts', 'duplicate\nx\nduplicate\n');
    write(workspace, 'src/stale.ts', 'different\n');
    const moved = storage.addThread(
        'src/moved.ts', 0, 0, 'needle', 'moved comment', 'tester'
    );
    const movedAgain = storage.addThread(
        'src/moved.ts', 9, 9, 'needle', 'same cached file', 'tester'
    );
    const ambiguous = storage.addThread(
        'src/ambiguous.ts', 9, 9, 'duplicate', 'ambiguous comment', 'tester'
    );
    const stale = storage.addThread(
        'src/stale.ts', 0, 0, 'missing anchor', 'stale comment', 'tester'
    );
    const before = fs.readFileSync(storage.filePath);
    const originalRead = fs.readFileSync;
    let movedReads = 0;
    fs.readFileSync = (filePath, ...args) => {
        if (String(filePath) === movedPath) {
            movedReads++;
        }
        return originalRead(filePath, ...args);
    };
    let reports;
    try {
        reports = storage.getReports();
    } finally {
        fs.readFileSync = originalRead;
    }
    assert.equal(movedReads, 1, 'source content is read once per path per report call');
    assert.deepEqual(fs.readFileSync(storage.filePath), before, 'projection does not rewrite v1');
    const byId = new Map(reports.map(report => [report.id, report]));
    assert.deepEqual(
        [byId.get(moved.id).anchorStatus, byId.get(moved.id).rangeStatus,
            byId.get(moved.id).effectiveStartLine],
        ['reanchored', 'reanchored', 1]
    );
    assert.equal(byId.get(movedAgain.id).anchorStatus, 'reanchored');
    assert.equal(byId.get(ambiguous.id).anchorStatus, 'ambiguous');
    assert.equal(byId.get(ambiguous.id).matches.length, 2);
    assert.equal(byId.get(stale.id).anchorStatus, 'notFound');
    assert.equal(byId.get(stale.id).rangeStatus, 'stale');

    const { WorkspaceCommentController } = built('workspaceComments/controller');
    const controller = new WorkspaceCommentController(storage, resolver);
    controller.loadAllThreads();
    const rendered = vscode.__createdCommentThreads.filter(thread =>
        thread.__workspaceThreadId === moved.id || thread.__workspaceThreadId === movedAgain.id
    );
    assert.equal(rendered.length, 2);
    assert.equal(rendered.every(thread => thread.range.start.line === 1), true);
    assert.equal(vscode.__createdCommentThreads.some(thread =>
        thread.__workspaceThreadId === ambiguous.id || thread.__workspaceThreadId === stale.id
    ), false);

    const { WorkspaceCommentsProvider } = built('workspaceComments/provider');
    const provider = new WorkspaceCommentsProvider(storage, resolver);
    const movedFile = provider.getChildren().find(item => item.filePath === 'src/moved.ts');
    const movedItem = provider.getChildren(movedFile).find(item => item.report.id === moved.id);
    assert.match(movedItem.description, /line 2.*reanchored/);
    assert.equal(movedItem.command.command, 'localPrReview.openCodeComment');
    const ambiguousFile = provider.getChildren().find(item => item.filePath === 'src/ambiguous.ts');
    assert.equal(provider.getChildren(ambiguousFile)[0].command, undefined);

    const { WorkspaceCommentsTool } = built('workspaceComments/tool');
    const payload = JSON.parse((await new WorkspaceCommentsTool(storage, resolver).invoke({
        input: { filePath: 'src/moved.ts' },
    }, undefined)).content[0].value);
    assert.deepEqual(
        [payload.threads[0].authoredStartLine, payload.threads[0].effectiveStartLine,
            payload.threads[0].anchorStatus, payload.threads[0].rangeStatus],
        [0, 1, 'reanchored', 'reanchored']
    );

    write(workspace, 'src/moved.ts', 'anchor removed\n');
    controller.loadAllThreads();
    assert.equal(rendered.every(thread => thread.disposed), true);
    assert.deepEqual(fs.readFileSync(storage.filePath), before);
    provider.dispose();
    controller.dispose();
});
