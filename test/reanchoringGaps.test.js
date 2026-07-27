'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { after, afterEach, test } = require('node:test');
const { installVscodeMock, vscode } = require('./helpers/vscodeMock');

const projectRoot = path.resolve(__dirname, '..');
const compiledRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'offline-reanchor-gaps-build-'));
execFileSync(path.join(projectRoot, 'node_modules', '.bin', 'tsc'), [
    '-p', projectRoot, '--outDir', compiledRoot,
    '--declaration', 'false', '--sourceMap', 'false',
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

function git(repository, ...args) {
    return execFileSync('git', args, {
        cwd: repository,
        encoding: 'utf8',
        env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' },
    }).trim();
}

function commit(repository, message) {
    git(repository, 'add', '--all');
    git(repository, 'commit', '-m', message);
    return git(repository, 'rev-parse', 'HEAD');
}

function repositoryState(branches) {
    const changes = new vscode.EventEmitter();
    return {
        state: {
            HEAD: { name: branches.at(-1), commit: undefined },
            onDidChange: changes.event,
        },
        async getBranches(query) {
            return query.remote ? [] : branches.map(name => ({ name }));
        },
    };
}

async function reviewFixture(mode = 'uncommitted') {
    const workspace = temporaryDirectory('offline-reanchor-gaps-');
    installVscodeMock(workspace);
    const { LocalPrManager } = built('services/localPrManager');
    const { StorageService } = built('storage/storageService');
    const head = 'a'.repeat(40);
    const manager = new LocalPrManager({
        async getCommitHash(ref) {
            return ref === 'main' ? 'b'.repeat(40) : head;
        },
    }, workspace);
    const review = mode === 'uncommitted'
        ? await manager.createUncommittedReview('feature', false)
        : await manager.createBranchReview('main', 'feature', false);
    manager.setActiveReview(review.id);
    return { workspace, manager, review, storage: new StorageService(manager), head };
}

function worktreePlan(review, workspace, head, planId = '11111111-1111-4111-8111-111111111111') {
    return {
        kind: 'worktree', reviewId: review.id, worktreeRoot: workspace,
        branch: review.branch, headCommit: head, planId,
        left: { kind: 'git', ref: head },
        right: {
            kind: 'worktree', reviewId: review.id, headCommit: head,
            planId, worktreeRoot: workspace,
        },
    };
}

test('review creation reuses exact open documents, falls back once, and shares cached author identity', async () => {
    const { workspace, review, storage, head } = await reviewFixture();
    const plan = worktreePlan(review, workspace, head);
    const { getDiffDocumentUri } = built('git/gitService');
    const uri = getDiffDocumentUri(
        plan.right, 'file.ts', 'modified', review.id, workspace
    );
    const lines = ['first', 'second'];
    const textDocument = {
        uri,
        lineCount: lines.length,
        lineAt(line) {
            return {
                text: lines[line],
                range: { end: { character: lines[line].length } },
            };
        },
    };
    const { AuthorIdentity } = built('authorIdentity');
    let userInfoCalls = 0;
    const fallbackIdentity = new AuthorIdentity({}, () => {
        userInfoCalls++;
        return { username: 'fallback-user' };
    });
    assert.equal(fallbackIdentity.get(), 'fallback-user');
    assert.equal(fallbackIdentity.get(), 'fallback-user');
    assert.equal(userInfoCalls, 1);
    const environmentIdentity = new AuthorIdentity(
        { USER: ' session-user ', USERNAME: 'ignored' },
        () => { throw new Error('environment author should avoid userInfo'); }
    );

    const { ReviewAnchorResolver } = built('comments/reviewAnchorResolver');
    const resolver = new ReviewAnchorResolver({}, storage);
    const prepared = Object.freeze({ plan, projections: Object.freeze([]) });
    resolver.applyPreparedState(prepared);
    const { ReviewCommentController } = built('comments/commentController');
    const controller = new ReviewCommentController(storage, resolver, environmentIdentity);
    controller.setReviewableFiles(['file.ts']);
    controller.loadAllThreads(plan, prepared);

    let openCalls = 0;
    vscode.workspace.textDocuments = [textDocument];
    vscode.workspace.openTextDocument = async () => {
        openCalls++;
        return textDocument;
    };
    await controller.createThread(
        uri, new vscode.Range(0, 0, 0, 0), 'warm', 'file.ts'
    );
    assert.equal(openCalls, 0, 'an exact warm review document is reused');

    vscode.workspace.textDocuments = [];
    await controller.createThread(
        uri, new vscode.Range(1, 0, 1, 0), 'cold', 'file.ts'
    );
    assert.equal(openCalls, 1, 'a cold review document uses one fallback open');

    await controller.createThread(
        uri,
        new vscode.Range(0, 0, 0, 0),
        'captured suggestion',
        'file.ts',
        undefined,
        review.id,
        textDocument
    );
    assert.equal(openCalls, 1, 'a suggestion reuses its safely captured document');
    const rendered = vscode.__createdCommentThreads.at(-1);
    controller.addReply(rendered, 'same session author');
    const authors = storage.loadCommentsForReview(review.id).threads
        .flatMap(thread => thread.comments.map(comment => comment.author));
    assert.deepEqual([...new Set(authors)], ['session-user']);
});

test('production transition coordinator retries in-process comment mutations and publishes every consumer consistently', async () => {
    const { workspace, manager, review, storage, head } = await reviewFixture();
    const plan = worktreePlan(review, workspace, head);
    const target = {
        kind: 'worktree', reviewId: review.id, headCommit: head,
        planId: plan.planId, filePath: 'file.ts',
    };
    storage.addThread(
        review.id, target, 'file.ts', 0, 0, 'existing', 'tester', 'existing'
    );

    let releaseRead;
    let readStarted;
    const started = new Promise(resolve => { readStarted = resolve; });
    const blocked = new Promise(resolve => { releaseRead = resolve; });
    let blockFirstRead = true;
    const gitService = {
        getSelectedWorktreeRoot: () => workspace,
        async getCurrentBranch() { return 'feature'; },
        async getFileContentResult() {
            if (blockFirstRead) {
                blockFirstRead = false;
                readStarted();
                await blocked;
            }
            return { status: 'available', content: 'existing\nnew anchor\n' };
        },
        async getChangedFiles() {
            return [{ status: 'modified', filePath: 'file.ts' }];
        },
        async getCommitsForDiff() { return []; },
        getFileDiffUris(currentPlan, file) {
            return built('git/gitService').getFileDiffUris(currentPlan, file);
        },
    };
    const { ReviewAnchorResolver } = built('comments/reviewAnchorResolver');
    const { ReviewTransitionCoordinator } = built('services/reviewTransitionCoordinator');
    const resolver = new ReviewAnchorResolver(gitService, storage);
    const coordinator = new ReviewTransitionCoordinator(storage);
    const generation = coordinator.beginTransition();
    const preparing = coordinator.prepareStable({
        generation,
        reviewId: review.id,
        worktreeRoot: workspace,
        prepare: () => resolver.prepare(plan, [{ status: 'modified', filePath: 'file.ts' }]),
    });
    await started;
    const added = storage.addThread(
        review.id, target, 'file.ts', 1, 1, 'new during prepare', 'tester', 'new anchor'
    );
    releaseRead();
    const prepared = await preparing;
    assert.equal(prepared.status, 'prepared');
    assert.equal(prepared.attempts, 2);
    assert.equal(storage.loadCommentsForReview(review.id).threads.length, 2);
    assert.equal(prepared.value.projections.some(projection =>
        projection.thread.id === added.id && projection.anchorStatus === 'current'
    ), true);
    resolver.applyPreparedState(prepared.value);

    const { ReviewCommentController } = built('comments/commentController');
    const controller = new ReviewCommentController(storage, resolver);
    controller.setReviewableFiles(['file.ts']);
    controller.loadAllThreads(plan, prepared.value);
    assert.equal(vscode.__createdCommentThreads.length, 2);

    const { ChangedFilesProvider } = built('views/changedFilesProvider');
    const changed = new ChangedFilesProvider(gitService, storage, manager, resolver);
    assert.equal(await changed.refresh(plan), true);
    changed.getChildren();
    assert.equal(changed.getAllFileItems()[0].commentCount, 2);

    const { ReviewFileDecorationProvider } = built('decorations/fileDecorationProvider');
    const decoration = new ReviewFileDecorationProvider(storage, gitService, resolver)
        .provideFileDecoration(vscode.Uri.file(path.join(workspace, 'file.ts')));
    assert.equal(decoration.badge, '2');

    const { LocalReviewTool } = built('tools/localReviewTool');
    const payload = JSON.parse((await new LocalReviewTool(
        gitService, manager, storage, resolver
    ).invoke({ input: {} }, undefined)).content[0].value);
    assert.equal(payload.threads.length, 2);
    assert.equal(payload.threads.find(thread => thread.id === added.id).anchorStatus, 'current');
});

test('production transition coordinator retries source and watcher dirtiness and rejects an older winner', async () => {
    const { workspace, manager, review, storage } = await reviewFixture();
    const { ReviewTransitionCoordinator } = built('services/reviewTransitionCoordinator');
    const coordinator = new ReviewTransitionCoordinator(storage);

    let releaseSource;
    let sourceStarted;
    const sourceReady = new Promise(resolve => { sourceStarted = resolve; });
    const sourceBlocked = new Promise(resolve => { releaseSource = resolve; });
    let sourceCalls = 0;
    const sourceGeneration = coordinator.beginTransition();
    const sourcePreparation = coordinator.prepareStable({
        generation: sourceGeneration,
        reviewId: review.id,
        worktreeRoot: workspace,
        prepare: async () => {
            sourceCalls++;
            if (sourceCalls === 1) {
                sourceStarted();
                await sourceBlocked;
            }
            return sourceCalls;
        },
    });
    await sourceReady;
    coordinator.markWorktreeChanged(workspace);
    releaseSource();
    const sourceResult = await sourcePreparation;
    assert.deepEqual(
        [sourceResult.status, sourceResult.attempts, sourceResult.value],
        ['prepared', 2, 2]
    );

    storage.ensureCommentsFileForReview(review.id);
    const commentsPath = path.join(
        workspace, '.vscode/local-reviews/reviews', review.id, 'comments.json'
    );
    let watcherRelease;
    let watcherStarted;
    const watcherReady = new Promise(resolve => { watcherStarted = resolve; });
    const watcherBlocked = new Promise(resolve => { watcherRelease = resolve; });
    let watcherCalls = 0;
    const watcherGeneration = coordinator.beginTransition();
    const watcherPreparation = coordinator.prepareStable({
        generation: watcherGeneration,
        reviewId: review.id,
        prepare: async () => {
            watcherCalls++;
            if (watcherCalls === 1) {
                watcherStarted();
                await watcherBlocked;
            }
            return watcherCalls;
        },
    });
    const { ReviewCommentsWatcherCoordinator } = built(
        'services/reviewCommentsWatcherCoordinator'
    );
    const watcher = new ReviewCommentsWatcherCoordinator(storage, () => {}, 10, 10);
    await watcherReady;
    const revisionBeforeOwnEvent = storage.getReviewRevision(review.id);
    assert.equal(storage.classifyWatch(commentsPath), 'exactOwnWrite');
    watcher.notify(review.id, commentsPath);
    assert.equal(storage.getReviewRevision(review.id), revisionBeforeOwnEvent);
    watcherRelease();
    const watcherResult = await watcherPreparation;
    assert.deepEqual(
        [watcherResult.status, watcherResult.attempts, watcherResult.value],
        ['prepared', 1, 1]
    );
    watcher.dispose();

    const newerReview = await manager.createBranchReview('main', 'newer', false);
    let releaseOld;
    let oldStarted;
    const oldReady = new Promise(resolve => { oldStarted = resolve; });
    const oldBlocked = new Promise(resolve => { releaseOld = resolve; });
    const oldGeneration = coordinator.beginTransition();
    const old = coordinator.prepareStable({
        generation: oldGeneration,
        reviewId: review.id,
        prepare: async () => {
            oldStarted();
            await oldBlocked;
            return 'old-plan';
        },
    });
    await oldReady;
    const latestGeneration = coordinator.beginTransition();
    const latest = await coordinator.prepareStable({
        generation: latestGeneration,
        reviewId: newerReview.id,
        prepare: async () => 'latest-plan',
    });
    releaseOld();
    assert.equal(latest.status, 'prepared');
    assert.equal(latest.value, 'latest-plan');
    assert.equal((await old).status, 'superseded');

    const noisyGeneration = coordinator.beginTransition();
    const noisy = await coordinator.prepareStable({
        generation: noisyGeneration,
        reviewId: review.id,
        worktreeRoot: workspace,
        maxAttempts: 3,
        prepare: async () => {
            coordinator.markWorktreeChanged(workspace);
            return 'unstable';
        },
    });
    assert.deepEqual([noisy.status, noisy.attempts], ['retry', 3]);
});

test('review watcher bounds own hash and absence recognition across A/B/A and deletion races', async () => {
    const { workspace, manager, review, head } = await reviewFixture();
    let now = 1_000;
    const ownWriteWindowMs = 15;
    const { StorageService } = built('storage/storageService');
    const storage = new StorageService(manager, () => now, ownWriteWindowMs);
    const target = {
        kind: 'worktree', reviewId: review.id, headCommit: head,
        planId: '22222222-2222-4222-8222-222222222222', filePath: 'file.ts',
    };
    const thread = storage.addThread(
        review.id, target, 'file.ts', 0, 0, 'body A', 'tester', 'line'
    );
    const commentsPath = path.join(
        workspace, '.vscode/local-reviews/reviews', review.id, 'comments.json'
    );
    const bytesA = fs.readFileSync(commentsPath);
    let refreshes = 0;
    const { ReviewCommentsWatcherCoordinator } = built(
        'services/reviewCommentsWatcherCoordinator'
    );
    const watcher = new ReviewCommentsWatcherCoordinator(
        storage, () => refreshes++, 2, 1
    );
    await new Promise(resolve => setImmediate(resolve));

    const revisionAfterInternalA = storage.getReviewRevision(review.id);
    assert.equal(storage.classifyWatch(commentsPath), 'exactOwnWrite');
    watcher.notify(review.id, commentsPath);
    watcher.notify(review.id, commentsPath);
    assert.equal(storage.getReviewRevision(review.id), revisionAfterInternalA);
    assert.equal(refreshes, 0, 'multiple immediate events for internal A are ignored');

    const externalB = JSON.parse(bytesA.toString('utf8'));
    externalB.threads[0].comments[0].body = 'external B';
    fs.writeFileSync(commentsPath, JSON.stringify(externalB, null, 2));
    assert.equal(storage.classifyWatch(commentsPath), 'suppressed');
    watcher.notify(review.id, commentsPath);
    assert.equal(storage.getReviewRevision(review.id), revisionAfterInternalA + 1);
    now += ownWriteWindowMs + 1;
    await new Promise(resolve => setTimeout(resolve, ownWriteWindowMs + 10));
    assert.equal(refreshes, 1, 'mismatched external B refreshes after suppression');

    fs.writeFileSync(commentsPath, bytesA);
    assert.equal(storage.classifyWatch(commentsPath), 'external');
    watcher.notify(review.id, commentsPath);
    await new Promise(resolve => setTimeout(resolve, 8));
    assert.equal(refreshes, 2, 'later external bytes identical to A are not owned forever');

    storage.deleteComment(review.id, thread.id, thread.comments[0].id);
    await new Promise(resolve => setTimeout(resolve, 1));
    const revisionAfterInternalDelete = storage.getReviewRevision(review.id);
    assert.equal(fs.existsSync(commentsPath), false);
    assert.equal(storage.classifyWatch(commentsPath), 'exactOwnWrite');
    watcher.notify(review.id, commentsPath);
    watcher.notify(review.id, commentsPath);
    assert.equal(storage.getReviewRevision(review.id), revisionAfterInternalDelete);

    now += ownWriteWindowMs + 1;
    assert.equal(storage.classifyWatch(commentsPath), 'external');
    fs.mkdirSync(path.dirname(commentsPath), { recursive: true });
    fs.writeFileSync(commentsPath, bytesA);
    watcher.notify(review.id, commentsPath);
    fs.unlinkSync(commentsPath);
    watcher.notify(review.id, commentsPath);
    await new Promise(resolve => setTimeout(resolve, 8));
    assert.equal(refreshes, 3, 'later external recreation/deletion of an absent path refreshes');
    watcher.dispose();
});

test('review own writes cannot shorten an explicit watcher suppression deadline', async () => {
    const { manager, review } = await reviewFixture();
    let now = 10_000;
    const { StorageService } = built('storage/storageService');
    const storage = new StorageService(manager, () => now, 15);
    await storage.withWatchSuppressed(() => {
        storage.ensureCommentsFileForReview(review.id);
        now += 1;
    });
    assert.equal(storage.msUntilWatchAllowed(), 4_999);
});

test('malformed present review comments refuse every mutation without changing bytes', async () => {
    const { workspace, review, storage } = await reviewFixture('branch');
    const target = { kind: 'git', ref: 'a'.repeat(40), filePath: 'file.ts' };
    const valid = storage.addThread(
        review.id, target, 'file.ts', 0, 0, 'body', 'tester', 'line'
    );
    const commentsPath = path.join(
        workspace, '.vscode/local-reviews/reviews', review.id, 'comments.json'
    );
    const malformed = JSON.parse(fs.readFileSync(commentsPath, 'utf8'));
    malformed.threads[0].sourceAnchor = 42;
    const bytes = Buffer.from(JSON.stringify(malformed));
    fs.writeFileSync(commentsPath, bytes);
    assert.deepEqual(storage.loadCommentsForReview(review.id).threads, []);

    const operations = [
        () => storage.addThread(
            review.id, target, 'file.ts', 0, 0, 'new', 'tester', 'line'
        ),
        () => storage.addReplyToThread(review.id, valid.id, 'reply', 'tester'),
        () => storage.editComment(
            review.id, valid.id, valid.comments[0].id, 'edited'
        ),
        () => storage.deleteComment(review.id, valid.id, valid.comments[0].id),
        () => storage.resolveThread(review.id, valid.id),
        () => storage.unresolveThread(review.id, valid.id),
    ];
    for (const operation of operations) {
        assert.throws(operation, /malformed or unsupported.*refusing to overwrite/i);
        assert.deepEqual(fs.readFileSync(commentsPath), bytes);
    }
});

test('workspace absent reads stay non-mutating and delayed open uses the latest effective range', async () => {
    const workspace = temporaryDirectory('offline-workspace-wiring-');
    installVscodeMock(workspace);
    const sourcePath = write(workspace, 'src/file.ts', 'anchor\n');
    const { WorkspacePathResolver } = built('workspaceComments/pathResolver');
    const { WorkspaceCommentStorage } = built('workspaceComments/storage');
    const {
        WorkspaceCommentOpener,
        WorkspaceCommentRefresher,
        WorkspaceCommentsWatcherCoordinator,
    } = built('workspaceComments/wiring');
    const resolver = new WorkspacePathResolver(workspace);
    const storage = new WorkspaceCommentStorage(workspace, resolver);
    assert.deepEqual(storage.load(), { version: 1, threads: [] });
    assert.deepEqual(storage.getReports(), []);
    assert.equal(fs.existsSync(path.join(workspace, '.vscode')), false);

    const thread = storage.addThread(
        'src/file.ts', 0, 0, 'anchor', 'body', 'tester'
    );
    assert.equal(fs.existsSync(path.join(workspace, '.vscode/local-reviews')), true);
    const before = fs.readFileSync(storage.filePath);
    const { WorkspaceCommentController } = built('workspaceComments/controller');
    const { WorkspaceCommentsProvider } = built('workspaceComments/provider');
    const { WorkspaceCommentsTool } = built('workspaceComments/tool');
    const controller = new WorkspaceCommentController(storage, resolver);
    const provider = new WorkspaceCommentsProvider(storage, resolver);
    const refresher = new WorkspaceCommentRefresher(resolver, controller, provider);
    controller.loadAllThreads();
    const rendered = vscode.__createdCommentThreads.at(-1);
    let providerRefreshes = 0;
    provider.onDidChangeTreeData(() => providerRefreshes++);
    fs.writeFileSync(sourcePath, 'before\nanchor\n');
    const document = {
        uri: vscode.Uri.file(sourcePath), lineCount: 3,
        lineAt(line) {
            const lines = ['before', 'anchor', ''];
            return {
                text: lines[line], range: { end: { character: lines[line].length } },
            };
        },
    };
    assert.equal(vscode.__createdCommentControllers.at(-1).commentingRangeProviderAssignments, 1);
    assert.equal(refresher.refreshAuthorizedSave(document), true);
    assert.equal(rendered.range.start.line, 1);
    assert.equal(providerRefreshes, 1);
    assert.equal(vscode.__createdCommentControllers.at(-1).commentingRangeProviderAssignments, 2);
    const toolPayload = JSON.parse((await new WorkspaceCommentsTool(
        storage, resolver
    ).invoke({ input: {} }, undefined)).content[0].value);
    assert.equal(toolPayload.threads[0].effectiveStartLine, 1);
    assert.deepEqual(fs.readFileSync(storage.filePath), before);

    let releaseOpen;
    let openStarted;
    const openReady = new Promise(resolve => { openStarted = resolve; });
    const openBlocked = new Promise(resolve => { releaseOpen = resolve; });
    vscode.workspace.openTextDocument = async uri => {
        openStarted();
        await openBlocked;
        const lines = fs.readFileSync(uri.fsPath, 'utf8').split(/\r\n|\r|\n/);
        return {
            uri, lineCount: lines.length,
            lineAt(line) {
                return {
                    text: lines[line],
                    range: { end: { character: lines[line].length } },
                };
            },
        };
    };
    const opening = new WorkspaceCommentOpener(storage, resolver)
        .open(thread.id, thread.filePath);
    await openReady;
    fs.writeFileSync(sourcePath, 'again\nbefore\nanchor\n');
    releaseOpen();
    const opened = await opening;
    assert.equal(opened.report.anchorStatus, 'reanchored');
    assert.deepEqual(
        [opened.range.start.line, opened.range.end.line],
        [2, 2]
    );
    assert.deepEqual(fs.readFileSync(storage.filePath), before);

    const externalComments = JSON.parse(fs.readFileSync(storage.filePath, 'utf8'));
    externalComments.threads[0].comments[0].body = 'external watcher edit';
    fs.writeFileSync(storage.filePath, JSON.stringify(externalComments, null, 2));
    const watcher = new WorkspaceCommentsWatcherCoordinator(
        storage, () => refresher.refresh(), 10, 10
    );
    watcher.notify(storage.filePath);
    await new Promise(resolve => setTimeout(resolve, 380));
    assert.equal(providerRefreshes, 2);
    assert.equal(storage.load().threads[0].comments[0].body, 'external watcher edit');
    watcher.dispose();
    provider.dispose();
    controller.dispose();
});

test('workspace watcher bounds own hash and absence recognition across A/B/A and deletion races', async () => {
    const workspace = temporaryDirectory('offline-workspace-watch-expiry-');
    installVscodeMock(workspace);
    write(workspace, 'src/file.ts', 'anchor\n');
    const { WorkspacePathResolver } = built('workspaceComments/pathResolver');
    const { WorkspaceCommentStorage } = built('workspaceComments/storage');
    const { WorkspaceCommentsWatcherCoordinator } = built('workspaceComments/wiring');
    const resolver = new WorkspacePathResolver(workspace);
    let now = 2_000;
    const ownWriteWindowMs = 15;
    const storage = new WorkspaceCommentStorage(
        workspace, resolver, () => now, ownWriteWindowMs
    );
    const thread = storage.addThread(
        'src/file.ts', 0, 0, 'anchor', 'body A', 'tester'
    );
    const bytesA = fs.readFileSync(storage.filePath);
    let refreshes = 0;
    const watcher = new WorkspaceCommentsWatcherCoordinator(
        storage, () => refreshes++, 2, 1
    );
    await new Promise(resolve => setImmediate(resolve));

    assert.equal(storage.classifyWatch(storage.filePath), 'exactOwnWrite');
    watcher.notify(storage.filePath);
    watcher.notify(storage.filePath);
    assert.equal(refreshes, 0, 'multiple immediate workspace events for internal A are ignored');

    const externalB = JSON.parse(bytesA.toString('utf8'));
    externalB.threads[0].comments[0].body = 'external B';
    fs.writeFileSync(storage.filePath, `${JSON.stringify(externalB, null, 2)}\n`);
    assert.equal(storage.classifyWatch(storage.filePath), 'suppressed');
    watcher.notify(storage.filePath);
    now += ownWriteWindowMs + 1;
    await new Promise(resolve => setTimeout(resolve, ownWriteWindowMs + 10));
    assert.equal(refreshes, 1, 'workspace external B refreshes after suppression');

    fs.writeFileSync(storage.filePath, bytesA);
    assert.equal(storage.shouldIgnoreWatch(storage.filePath), false);
    watcher.notify(storage.filePath);
    await new Promise(resolve => setTimeout(resolve, 8));
    assert.equal(refreshes, 2, 'later workspace bytes identical to A are external');

    storage.deleteComment(thread.id, thread.comments[0].id);
    await new Promise(resolve => setTimeout(resolve, 1));
    assert.equal(fs.existsSync(storage.filePath), false);
    assert.equal(storage.classifyWatch(storage.filePath), 'exactOwnWrite');
    watcher.notify(storage.filePath);
    watcher.notify(storage.filePath);
    assert.equal(refreshes, 2);

    now += ownWriteWindowMs + 1;
    assert.equal(storage.shouldIgnoreWatch(storage.filePath), false);
    fs.writeFileSync(storage.filePath, bytesA);
    watcher.notify(storage.filePath);
    fs.unlinkSync(storage.filePath);
    watcher.notify(storage.filePath);
    await new Promise(resolve => setTimeout(resolve, 8));
    assert.equal(refreshes, 3, 'later workspace recreation/deletion refreshes final absence');
    watcher.dispose();
});

test('GitService content results distinguish empty and unavailable immutable/worktree content', async () => {
    const repository = temporaryDirectory('offline-content-boundary-');
    installVscodeMock(repository);
    git(repository, 'init', '-b', 'main');
    git(repository, 'config', 'user.name', 'Offline Review Test');
    git(repository, 'config', 'user.email', 'offline-review@example.invalid');
    write(repository, 'empty.txt', '');
    const commitId = commit(repository, 'empty');
    const { GitService } = built('git/gitService');
    const service = new GitService({ subscriptions: [] });
    service.repo = repositoryState(['main']);

    assert.deepEqual(
        await service.getFileContentResult({ kind: 'git', ref: commitId }, 'empty.txt'),
        { status: 'available', content: '' }
    );
    assert.deepEqual(
        await service.getFileContentResult({ kind: 'git', ref: commitId }, 'missing.txt'),
        { status: 'unavailable' }
    );
    const plan = await service.prepareDiffPlan({
        id: '33333333-3333-4333-8333-333333333333', mode: 'uncommitted',
        branch: 'main', sourceCommit: commitId, targetCommit: commitId,
        createdAt: new Date(0).toISOString(),
    });
    assert.deepEqual(
        await service.getFileContentResult(plan.right, 'empty.txt'),
        { status: 'available', content: '' }
    );
    assert.deepEqual(
        await service.getFileContentResult(plan.right, 'missing.txt'),
        { status: 'unavailable' }
    );

    const { resolveExactLineSequence } = built('lineSequenceResolver');
    const zero = resolveExactLineSequence('', '', 0, 0);
    assert.deepEqual(
        [zero.status, zero.effectiveStartLine, zero.effectiveEndLine],
        ['current', 0, 0]
    );
});

test('real Git branch projections reanchor modified and original sides without writes', async () => {
    const repository = temporaryDirectory('offline-real-branch-anchor-');
    installVscodeMock(repository);
    git(repository, 'init', '-b', 'main');
    git(repository, 'config', 'user.name', 'Offline Review Test');
    git(repository, 'config', 'user.email', 'offline-review@example.invalid');
    write(repository, 'original.txt', 'base anchor\n');
    write(repository, 'empty.txt', '');
    const oldBase = commit(repository, 'old base');
    write(repository, 'original.txt', 'before\nbase anchor\n');
    const currentBase = commit(repository, 'current base');
    git(repository, 'checkout', '-b', 'feature');
    write(repository, 'modified.txt', 'feature anchor\n');
    const oldTarget = commit(repository, 'old feature');

    const { GitService } = built('git/gitService');
    const { LocalPrManager } = built('services/localPrManager');
    const { StorageService } = built('storage/storageService');
    const { ReviewAnchorResolver } = built('comments/reviewAnchorResolver');
    const service = new GitService({ subscriptions: [] });
    service.repo = repositoryState(['main', 'feature']);
    const manager = new LocalPrManager(service, repository);
    const review = await manager.createBranchReview('main', 'feature', false);
    const storage = new StorageService(manager);
    const modified = storage.addThread(
        review.id,
        { kind: 'git', ref: oldTarget, filePath: 'modified.txt' },
        'modified.txt', 0, 0, 'modified', 'tester'
    );
    const original = storage.addThread(
        review.id,
        { kind: 'git', ref: oldBase, side: 'original', filePath: 'original.txt' },
        'original.txt', 0, 0, 'original', 'tester'
    );
    const empty = storage.addThread(
        review.id,
        { kind: 'git', ref: oldTarget, filePath: 'empty.txt' },
        'empty.txt', 0, 0, 'empty', 'tester', ''
    );
    write(repository, 'modified.txt', 'before\nfeature anchor\n');
    const newTarget = commit(repository, 'new feature');
    const plan = await service.prepareDiffPlan(review);
    assert.equal(plan.mergeBaseCommit, currentBase);
    assert.equal(plan.targetCommit, newTarget);
    const commentsPath = manager.getCommentsFilePath(review);
    const before = fs.readFileSync(commentsPath);
    const state = await new ReviewAnchorResolver(service, storage).prepare(plan, [
        { status: 'modified', filePath: 'modified.txt' },
        { status: 'deleted', filePath: 'original.txt' },
        { status: 'modified', filePath: 'empty.txt' },
    ]);
    assert.deepEqual(fs.readFileSync(commentsPath), before);
    const byId = new Map(state.projections.map(projection => [projection.thread.id, projection]));
    assert.deepEqual(
        [byId.get(modified.id).anchorStatus, byId.get(modified.id).effectiveStartLine,
            byId.get(modified.id).effectiveEndLine],
        ['reanchored', 1, 1]
    );
    assert.deepEqual(
        [byId.get(original.id).side, byId.get(original.id).anchorStatus,
            byId.get(original.id).effectiveStartLine],
        ['original', 'reanchored', 1]
    );
    assert.deepEqual(
        [byId.get(empty.id).anchorStatus, byId.get(empty.id).effectiveStartLine,
            byId.get(empty.id).effectiveEndLine],
        ['current', 0, 0]
    );
});

test('linked-worktree content reads the prepared root and becomes unavailable when invalidated', async () => {
    const repository = temporaryDirectory('offline-linked-content-local-');
    const linkedParent = temporaryDirectory('offline-linked-content-parent-');
    const linkedRoot = path.join(linkedParent, 'linked');
    installVscodeMock(repository);
    git(repository, 'init', '-b', 'main');
    git(repository, 'config', 'user.name', 'Offline Review Test');
    git(repository, 'config', 'user.email', 'offline-review@example.invalid');
    write(repository, 'same.txt', 'local\n');
    commit(repository, 'base');
    git(repository, 'worktree', 'add', '-b', 'linked-feature', linkedRoot);
    write(linkedRoot, 'same.txt', 'linked current\n');

    const { GitService } = built('git/gitService');
    const service = new GitService({ subscriptions: [] });
    await service.selectWorktree(linkedRoot);
    const review = {
        id: '44444444-4444-4444-8444-444444444444', mode: 'uncommitted',
        branch: 'linked-feature', sourceCommit: git(linkedRoot, 'rev-parse', 'HEAD'),
        targetCommit: git(linkedRoot, 'rev-parse', 'HEAD'),
        createdAt: new Date(0).toISOString(),
    };
    const stalePlan = await service.prepareDiffPlan(review);
    assert.equal(stalePlan.worktreeRoot, linkedRoot);
    write(linkedRoot, 'same.txt', 'linked latest plan\n');
    const currentPlan = await service.prepareDiffPlan(review);
    assert.notEqual(stalePlan.planId, currentPlan.planId);
    assert.deepEqual(
        await service.getFileContentResult(currentPlan.right, 'same.txt'),
        { status: 'available', content: 'linked latest plan\n' }
    );
    assert.notEqual(
        (await service.getFileContentResult(currentPlan.right, 'same.txt')).content,
        'local\n'
    );
    git(repository, 'worktree', 'remove', '--force', linkedRoot);
    assert.deepEqual(
        await service.getFileContentResult(currentPlan.right, 'same.txt'),
        { status: 'unavailable' }
    );
});

test('consumer eligibility matrix renders only effective statuses and counts only unresolved effective threads', async () => {
    const { workspace, manager, review, storage, head } = await reviewFixture();
    const plan = worktreePlan(
        review, workspace, head, '55555555-5555-4555-8555-555555555555'
    );
    const add = (filePath, startLine, anchor, withAnchor = true) => storage.addThread(
        review.id,
        {
            kind: 'worktree', reviewId: review.id, headCommit: head,
            planId: plan.planId, filePath,
        },
        filePath, startLine, startLine, filePath, 'tester',
        withAnchor ? anchor : undefined
    );
    const current = add('current.ts', 0, 'current');
    const moved = add('moved.ts', 0, 'move');
    const legacy = add('legacy.ts', 0, '', false);
    const ambiguous = add('ambiguous.ts', 9, 'dup');
    const notFound = add('not-found.ts', 0, 'gone');
    const unavailable = add('unavailable.ts', 0, 'missing');
    const resolved = add('resolved.ts', 0, 'resolved');
    storage.resolveThread(review.id, resolved.id);
    const contents = {
        'current.ts': 'current\n',
        'moved.ts': 'before\nmove\n',
        'legacy.ts': 'legacy\n',
        'ambiguous.ts': 'dup\nx\ndup\n',
        'not-found.ts': 'different\n',
        'resolved.ts': 'resolved\n',
    };
    const gitService = {
        getSelectedWorktreeRoot: () => workspace,
        async getCurrentBranch() { return 'feature'; },
        async getFileContentResult(_document, filePath) {
            return Object.hasOwn(contents, filePath)
                ? { status: 'available', content: contents[filePath] }
                : { status: 'unavailable' };
        },
        async getChangedFiles() {
            return Object.keys({ ...contents, 'unavailable.ts': '' })
                .map(filePath => ({ status: 'modified', filePath }));
        },
        async getCommitsForDiff() { return []; },
        getFileDiffUris(currentPlan, file) {
            return built('git/gitService').getFileDiffUris(currentPlan, file);
        },
    };
    const files = await gitService.getChangedFiles();
    const { ReviewAnchorResolver } = built('comments/reviewAnchorResolver');
    const resolver = new ReviewAnchorResolver(gitService, storage);
    const state = await resolver.prepare(plan, files);
    resolver.applyPreparedState(state);
    const byId = new Map(state.projections.map(projection => [projection.thread.id, projection]));
    assert.deepEqual([
        byId.get(current.id).anchorStatus,
        byId.get(moved.id).anchorStatus,
        byId.get(legacy.id).anchorStatus,
        byId.get(ambiguous.id).anchorStatus,
        byId.get(notFound.id).anchorStatus,
        byId.get(unavailable.id).anchorStatus,
        byId.get(resolved.id).anchorStatus,
    ], ['current', 'reanchored', 'legacyCurrent', 'ambiguous', 'notFound', 'unavailable', 'current']);

    const { ReviewCommentController } = built('comments/commentController');
    const controller = new ReviewCommentController(storage, resolver);
    controller.setReviewableFiles(files.map(file => file.filePath));
    controller.loadAllThreads(plan, state);
    assert.equal(vscode.__createdCommentThreads.length, 4);
    assert.equal(vscode.__createdCommentThreads.some(thread =>
        thread.__threadData.threadId === resolved.id
        && thread.state === vscode.CommentThreadState.Resolved
    ), true);

    const { ChangedFilesProvider } = built('views/changedFilesProvider');
    const changed = new ChangedFilesProvider(gitService, storage, manager, resolver);
    assert.equal(await changed.refresh(plan), true);
    changed.getChildren();
    const countByPath = new Map(changed.getAllFileItems().map(item => [
        item.fileChange.filePath, item.commentCount,
    ]));
    assert.deepEqual([
        countByPath.get('current.ts'), countByPath.get('moved.ts'),
        countByPath.get('legacy.ts'), countByPath.get('ambiguous.ts'),
        countByPath.get('not-found.ts'), countByPath.get('unavailable.ts'),
        countByPath.get('resolved.ts'),
    ], [1, 1, 1, 0, 0, 0, 0]);

    const { ReviewFileDecorationProvider } = built('decorations/fileDecorationProvider');
    const decorations = new ReviewFileDecorationProvider(storage, gitService, resolver);
    assert.equal(decorations.provideFileDecoration(
        vscode.Uri.file(path.join(workspace, 'current.ts'))
    ).badge, '1');
    for (const filePath of ['ambiguous.ts', 'not-found.ts', 'unavailable.ts', 'resolved.ts']) {
        assert.equal(decorations.provideFileDecoration(
            vscode.Uri.file(path.join(workspace, filePath))
        ), undefined, filePath);
    }

    const { LocalReviewTool } = built('tools/localReviewTool');
    const tool = new LocalReviewTool(gitService, manager, storage, resolver);
    const toolPayload = JSON.parse((await tool.invoke({ input: {} }, undefined)).content[0].value);
    assert.deepEqual(
        new Map(toolPayload.threads.map(thread => [thread.id, thread.anchorStatus])),
        new Map(state.projections.map(projection => [
            projection.thread.id, projection.anchorStatus,
        ]))
    );

    const rendered = [...vscode.__createdCommentThreads];
    resolver.clear();
    controller.loadAllThreads(plan, state);
    assert.equal(rendered.every(thread => thread.disposed), true);
    changed.fireChange();
    changed.getChildren();
    assert.equal(changed.getAllFileItems().every(item => item.commentCount === 0), true);
    assert.equal(decorations.provideFileDecoration(
        vscode.Uri.file(path.join(workspace, 'current.ts'))
    ), undefined);
    const unavailablePayload = JSON.parse((await tool.invoke({ input: {} }, undefined)).content[0].value);
    assert.equal(unavailablePayload.threads.every(thread =>
        thread.anchorStatus === 'unavailable'
    ), true);
});

test('resolver handles malformed authored spans, empty-line ambiguity, and multiline effective ends', () => {
    const { resolveExactLineSequence } = built('lineSequenceResolver');
    for (const [start, end] of [
        [0, 1], [-1, -1], [Number.NaN, 0], [0, Number.POSITIVE_INFINITY],
    ]) {
        const result = resolveExactLineSequence('anchor', 'anchor', start, end);
        assert.deepEqual(
            [result.status, result.effectiveStartLine, result.effectiveEndLine],
            ['reanchored', 0, 0]
        );
    }
    const emptyAmbiguous = resolveExactLineSequence('\n', '', 9, 9);
    assert.equal(emptyAmbiguous.status, 'ambiguous');
    assert.deepEqual(
        emptyAmbiguous.matches.map(match => [match.startLine, match.endLine]),
        [[0, 0], [1, 1]]
    );
    const multiline = resolveExactLineSequence('x\na\nb\ny', 'a\nb', 9, 10);
    assert.deepEqual(
        [multiline.status, multiline.effectiveStartLine, multiline.effectiveEndLine],
        ['reanchored', 1, 2]
    );
});
