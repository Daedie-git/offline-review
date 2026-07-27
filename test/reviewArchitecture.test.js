'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { after, afterEach, test } = require('node:test');
const { installVscodeMock, vscode } = require('./helpers/vscodeMock');

const projectRoot = path.resolve(__dirname, '..');
const compiledRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'offline-review-test-build-'));
execFileSync(path.join(projectRoot, 'node_modules', '.bin', 'tsc'), [
    '-p', projectRoot,
    '--outDir', compiledRoot,
    '--declaration', 'false',
    '--sourceMap', 'false',
], { cwd: projectRoot, stdio: 'pipe' });
const built = relativePath => require(path.join(compiledRoot, relativePath));

after(() => {
    fs.rmSync(compiledRoot, { recursive: true, force: true });
});

const temporaryDirectories = [];

afterEach(() => {
    while (temporaryDirectories.length > 0) {
        fs.rmSync(temporaryDirectories.pop(), { recursive: true, force: true });
    }
});

function temporaryDirectory(prefix) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    temporaryDirectories.push(directory);
    return directory;
}

function git(repository, ...args) {
    return execFileSync('git', args, {
        cwd: repository,
        encoding: 'utf8',
        env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' },
    }).trim();
}

function write(repository, relativePath, content) {
    const filePath = path.join(repository, relativePath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, 'utf8');
}

function commit(repository, message) {
    git(repository, 'add', '--all');
    git(repository, 'commit', '-m', message);
    return git(repository, 'rev-parse', 'HEAD');
}

function repositoryState(branch, branches) {
    const changes = new vscode.EventEmitter();
    return {
        state: {
            HEAD: { name: branch, commit: undefined },
            onDidChange: changes.event,
        },
        async getBranches(query) {
            return query.remote ? [] : branches.map(name => ({ name }));
        },
    };
}

test('branch plans exclude worktree edits while worktree plans include them', async () => {
    const repository = temporaryDirectory('offline-review-git-');
    installVscodeMock(repository);
    git(repository, 'init', '-b', 'main');
    git(repository, 'config', 'user.name', 'Offline Review Test');
    git(repository, 'config', 'user.email', 'offline-review@example.invalid');

    write(repository, 'base.txt', 'base\n');
    const baseCommit = commit(repository, 'base');
    git(repository, 'checkout', '-b', 'feature');
    write(repository, 'feature.txt', 'feature\n');
    const firstFeatureCommit = commit(repository, 'feature');

    const { GitService } = built('git/gitService');
    const context = { subscriptions: [] };
    const service = new GitService(context);
    service.repo = repositoryState('feature', ['main', 'feature']);

    const branchReview = {
        id: '11111111-1111-4111-8111-111111111111',
        mode: 'branch',
        baseBranch: 'main',
        targetBranch: 'feature',
        sourceCommit: baseCommit,
        targetCommit: firstFeatureCommit,
        createdAt: new Date(0).toISOString(),
    };

    const firstPlan = await service.prepareDiffPlan(branchReview);
    assert.equal(firstPlan.kind, 'branch');
    assert.equal(firstPlan.targetCommit, firstFeatureCommit);
    assert.deepEqual(
        (await service.getChangedFiles(firstPlan)).map(change => change.filePath),
        ['feature.txt']
    );

    write(repository, 'later.txt', 'later\n');
    const latestFeatureCommit = commit(repository, 'later feature commit');
    const refreshedPlan = await service.prepareDiffPlan(branchReview);
    assert.equal(refreshedPlan.targetCommit, latestFeatureCommit);
    assert.notEqual(refreshedPlan.targetCommit, firstPlan.targetCommit);
    assert.deepEqual(
        (await service.getChangedFiles(refreshedPlan)).map(change => change.filePath).sort(),
        ['feature.txt', 'later.txt']
    );

    write(repository, 'base.txt', 'unstaged worktree edit\n');
    write(repository, 'staged.txt', 'staged\n');
    git(repository, 'add', 'staged.txt');
    write(repository, 'untracked.txt', 'untracked\n');

    const branchFilesWithWorktreeEdits = await service.getChangedFiles(refreshedPlan);
    assert.deepEqual(
        branchFilesWithWorktreeEdits.map(change => change.filePath).sort(),
        ['feature.txt', 'later.txt']
    );
    assert.equal(refreshedPlan.right.kind, 'git');

    const worktreeReview = {
        id: '22222222-2222-4222-8222-222222222222',
        mode: 'uncommitted',
        branch: 'feature',
        sourceCommit: latestFeatureCommit,
        targetCommit: latestFeatureCommit,
        createdAt: new Date(0).toISOString(),
    };
    const worktreePlan = await service.prepareDiffPlan(worktreeReview);
    const nextWorktreePlan = await service.prepareDiffPlan(worktreeReview);
    assert.equal(worktreePlan.kind, 'worktree');
    assert.equal(worktreePlan.right.kind, 'worktree');
    assert.notEqual(worktreePlan.planId, nextWorktreePlan.planId);
    assert.notEqual(
        service.getFileDiffUris(worktreePlan, { status: 'modified', filePath: 'base.txt' }).right.toString(),
        service.getFileDiffUris(nextWorktreePlan, { status: 'modified', filePath: 'base.txt' }).right.toString()
    );
    assert.deepEqual(
        (await service.getChangedFiles(worktreePlan)).map(change => change.filePath).sort(),
        ['base.txt', 'staged.txt', 'untracked.txt']
    );

    await assert.rejects(
        service.prepareDiffPlan({ ...worktreeReview, branch: 'main' }),
        /saved for branch "main"/
    );
});

test('concurrent review creation is deduplicated per discriminated identity', async () => {
    const workspace = temporaryDirectory('offline-review-creation-');
    installVscodeMock(workspace);

    let releaseBranchCommits;
    const branchCommitsReady = new Promise(resolve => {
        releaseBranchCommits = resolve;
    });
    const commitCalls = [];
    const managerGitService = {
        async getCommitHash(ref) {
            commitCalls.push(ref);
            if (ref === 'base' || ref === 'feature') {
                await branchCommitsReady;
            }
            return ref === 'base' ? 'a'.repeat(40)
                : ref === 'feature' ? 'b'.repeat(40)
                    : 'c'.repeat(40);
        },
    };

    const { LocalPrManager } = built('services/localPrManager');
    const manager = new LocalPrManager(managerGitService, workspace);
    const firstBranchCreation = manager.createBranchReview('base', 'feature', false);
    const secondBranchCreation = manager.createBranchReview('base', 'feature', false);

    // A different identity is not serialized behind the pending branch review.
    const [firstUncommitted, secondUncommitted] = await Promise.all([
        manager.createUncommittedReview('worktree', false),
        manager.createUncommittedReview('worktree', false),
    ]);
    assert.strictEqual(firstUncommitted, secondUncommitted);
    assert.equal(manager.listReviews().length, 1);

    releaseBranchCommits();
    const [firstBranch, secondBranch] = await Promise.all([
        firstBranchCreation,
        secondBranchCreation,
    ]);
    assert.strictEqual(firstBranch, secondBranch);
    assert.equal(manager.getCommentsFilePath(firstBranch), manager.getCommentsFilePath(secondBranch));
    assert.equal(manager.getCommentsFilePath(firstUncommitted), manager.getCommentsFilePath(secondUncommitted));
    assert.deepEqual(commitCalls.sort(), ['base', 'feature', 'worktree']);

    const reviews = manager.listReviews();
    assert.equal(reviews.length, 2);
    assert.equal(reviews.filter(review => review.mode === 'branch').length, 1);
    assert.equal(reviews.filter(review => review.mode === 'uncommitted').length, 1);
    const registry = JSON.parse(fs.readFileSync(
        path.join(workspace, '.vscode', 'local-reviews', 'registry.json'),
        'utf8'
    ));
    assert.equal(registry.reviews.length, 2);
    manager.dispose();
});

test('checkout events include same-commit detach and reattach transitions', () => {
    installVscodeMock('/tmp/offline-review-checkout-test');
    const changes = new vscode.EventEmitter();
    const sameCommit = 'a'.repeat(40);
    const repository = {
        state: {
            HEAD: { name: 'main', commit: sameCommit },
            onDidChange: changes.event,
        },
        async getBranches() {
            return [{ name: 'main' }];
        },
    };

    const { GitService } = built('git/gitService');
    const context = { subscriptions: [] };
    const service = new GitService(context);
    service.repo = repository;
    service.trackBranchChanges();

    const checkouts = [];
    const namedBranches = [];
    let headChanges = 0;
    const checkoutDisposable = service.onDidChangeCheckout(change => checkouts.push(change));
    const branchDisposable = service.onDidChangeBranch(branch => namedBranches.push(branch));
    const headDisposable = service.onDidChangeHead(() => headChanges++);

    repository.state.HEAD = { name: undefined, commit: sameCommit };
    changes.fire();
    repository.state.HEAD = { name: 'main', commit: sameCommit };
    changes.fire();

    assert.deepEqual(checkouts, [
        { previousBranch: 'main', branch: undefined },
        { previousBranch: undefined, branch: 'main' },
    ]);
    assert.deepEqual(namedBranches, ['main']);
    assert.equal(headChanges, 0);

    checkoutDisposable.dispose();
    branchDisposable.dispose();
    headDisposable.dispose();
    for (const disposable of context.subscriptions) {
        disposable.dispose();
    }
});

test('latest applied branch tips persist as fallbacks after target deletion', async () => {
    const repository = temporaryDirectory('offline-review-fallback-');
    installVscodeMock(repository);
    git(repository, 'init', '-b', 'main');
    git(repository, 'config', 'user.name', 'Offline Review Test');
    git(repository, 'config', 'user.email', 'offline-review@example.invalid');

    write(repository, 'base.txt', 'base\n');
    const baseCommit = commit(repository, 'base');
    git(repository, 'checkout', '-b', 'feature');
    write(repository, 'feature.txt', 'first\n');
    commit(repository, 'first feature commit');

    const { GitService } = built('git/gitService');
    const { LocalPrManager } = built('services/localPrManager');
    const service = new GitService({ subscriptions: [] });
    service.repo = repositoryState('feature', ['main', 'feature']);
    const manager = new LocalPrManager(service, repository);
    const review = await manager.createBranchReview('main', 'feature', false);

    write(repository, 'feature.txt', 'latest\n');
    write(repository, 'latest.txt', 'latest snapshot\n');
    git(repository, 'add', 'feature.txt', 'latest.txt');
    git(repository, 'commit', '-m', 'latest feature commit');
    const latestTargetCommit = git(repository, 'rev-parse', 'HEAD');
    const latestPlan = await service.prepareDiffPlan(review);
    assert.equal(latestPlan.baseCommit, baseCommit);
    assert.equal(latestPlan.targetCommit, latestTargetCommit);

    let managerChanges = 0;
    const managerDisposable = manager.onDidChange(() => managerChanges++);
    assert.equal(manager.updateBranchReviewFallbackCommits(
        latestPlan.reviewId,
        latestPlan.baseCommit,
        latestPlan.targetCommit
    ), true);
    assert.equal(managerChanges, 1);
    assert.equal(manager.updateBranchReviewFallbackCommits(
        latestPlan.reviewId,
        latestPlan.baseCommit,
        latestPlan.targetCommit
    ), false);
    assert.equal(managerChanges, 1);
    managerDisposable.dispose();
    manager.dispose();

    git(repository, 'checkout', 'main');
    git(repository, 'branch', '-D', 'feature');

    // Reconstructing the manager proves the fallback was written to the registry.
    const restoredManager = new LocalPrManager(service, repository);
    const restoredReview = restoredManager.getReviewById(review.id);
    assert.equal(restoredReview.sourceCommit, baseCommit);
    assert.equal(restoredReview.targetCommit, latestTargetCommit);
    const fallbackPlan = await service.prepareDiffPlan(restoredReview);
    assert.equal(fallbackPlan.baseCommit, baseCommit);
    assert.equal(fallbackPlan.targetCommit, latestTargetCommit);
    assert.deepEqual(
        (await service.getChangedFiles(fallbackPlan)).map(change => change.filePath).sort(),
        ['feature.txt', 'latest.txt']
    );
    restoredManager.dispose();
});

test('a superseded changed-files refresh cannot overwrite the latest review state', async () => {
    installVscodeMock('/tmp/offline-review-provider-test');
    const reviewA = {
        id: '55555555-5555-4555-8555-555555555555',
        mode: 'branch',
        baseBranch: 'main',
        targetBranch: 'slow',
        sourceCommit: 'a'.repeat(40),
        targetCommit: 'b'.repeat(40),
        createdAt: new Date(0).toISOString(),
    };
    const reviewB = {
        id: '66666666-6666-4666-8666-666666666666',
        mode: 'branch',
        baseBranch: 'main',
        targetBranch: 'fast',
        sourceCommit: 'a'.repeat(40),
        targetCommit: 'c'.repeat(40),
        createdAt: new Date(0).toISOString(),
    };
    const planFor = review => ({
        kind: 'branch',
        reviewId: review.id,
        baseBranch: review.baseBranch,
        targetBranch: review.targetBranch,
        baseCommit: 'a'.repeat(40),
        mergeBaseCommit: 'a'.repeat(40),
        targetCommit: review.targetCommit,
        left: { kind: 'git', ref: 'a'.repeat(40) },
        right: { kind: 'git', ref: review.targetCommit },
    });
    const gitService = {
        async prepareDiffPlan(review) {
            if (review.id === reviewA.id) {
                await new Promise(resolve => setTimeout(resolve, 40));
            }
            return planFor(review);
        },
        async getChangedFiles(plan) {
            return [{ status: 'modified', filePath: `${plan.targetBranch}.txt` }];
        },
        async getCommitsForDiff() {
            return [];
        },
        getFileDiffUris() {
            return { left: vscode.Uri.file('/left'), right: vscode.Uri.file('/right') };
        },
    };
    const manager = {
        getReviewedFiles: () => [],
        listReviews: () => [reviewA, reviewB],
        getActiveReview: () => reviewB,
        setReviewedFiles() {},
    };
    const storage = { loadComments: () => undefined };
    const { ChangedFilesProvider } = built('views/changedFilesProvider');
    const provider = new ChangedFilesProvider(gitService, storage, manager);

    const slowRefresh = provider.refresh(reviewA);
    const fastRefresh = provider.refresh(reviewB);
    assert.equal(await fastRefresh, true);
    assert.equal(await slowRefresh, false);
    assert.equal(provider.getDiffPlan().reviewId, reviewB.id);
    assert.deepEqual(provider.getAllFilePaths(), ['fast.txt']);
    provider.dispose();
});

test('worktree URIs carry prepared identity and file refresh invalidates every matching open document', async () => {
    installVscodeMock('/tmp/offline-review-uri-test');
    const {
        getDiffDocumentUri,
        parseDiffDocumentUri,
    } = built('git/gitService');
    const { GitFileContentProvider } = built('git/gitFileContentProvider');
    const reviewA = '77777777-7777-4777-8777-777777777777';
    const reviewB = '88888888-8888-4888-8888-888888888888';
    const headA = 'a'.repeat(40);
    const headB = 'b'.repeat(40);
    const planA = '99999999-9999-4999-8999-999999999999';
    const planB = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const planC = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const uriA = getDiffDocumentUri(
        { kind: 'worktree', reviewId: reviewA, headCommit: headA, planId: planA },
        'src/file.txt',
        'modified',
        reviewA
    );
    const uriB = getDiffDocumentUri(
        { kind: 'worktree', reviewId: reviewB, headCommit: headA, planId: planB },
        'src/file.txt',
        'modified',
        reviewB
    );
    const uriNewHead = getDiffDocumentUri(
        { kind: 'worktree', reviewId: reviewA, headCommit: headB, planId: planC },
        'src/file.txt',
        'modified',
        reviewA
    );
    const uriNewPlan = getDiffDocumentUri(
        { kind: 'worktree', reviewId: reviewA, headCommit: headA, planId: planB },
        'src/file.txt',
        'modified',
        reviewA
    );
    assert.notEqual(uriA.toString(), uriB.toString());
    assert.notEqual(uriA.toString(), uriNewHead.toString());
    assert.notEqual(uriA.toString(), uriNewPlan.toString());
    assert.deepEqual(parseDiffDocumentUri(uriA), {
        filePath: 'src/file.txt',
        side: 'modified',
        reviewId: reviewA,
        document: {
            kind: 'worktree',
            reviewId: reviewA,
            headCommit: headA,
            planId: planA,
        },
    });

    const otherFile = getDiffDocumentUri(
        { kind: 'worktree', reviewId: reviewA, headCommit: headA, planId: planA },
        'src/other.txt',
        'modified',
        reviewA
    );
    const immutable = getDiffDocumentUri(
        { kind: 'git', ref: headA },
        'src/file.txt',
        'modified',
        reviewA
    );
    vscode.workspace.textDocuments = [uriA, uriB, uriNewHead, uriNewPlan, otherFile, immutable]
        .map(uri => ({ uri }));
    const contentCalls = [];
    const provider = new GitFileContentProvider({
        async getFileContent(ref, filePath) {
            contentCalls.push([ref, filePath]);
            return 'content';
        },
    });
    const invalidated = [];
    const disposable = provider.onDidChange(uri => invalidated.push(uri.toString()));
    provider.refreshWorkingTreeFile('src/file.txt');
    assert.deepEqual(
        invalidated,
        [uriA, uriB, uriNewHead, uriNewPlan].map(uri => uri.toString())
    );

    const malformed = vscode.Uri.from({
        scheme: 'git-local-review',
        authority: 'authority',
        path: '/src/file.txt',
        query: 'ref=WORKTREE&side=modified',
    });
    assert.equal(await provider.provideTextDocumentContent(malformed), '');
    assert.deepEqual(contentCalls, []);
    assert.equal(await provider.provideTextDocumentContent(uriA), 'content');
    assert.deepEqual(contentCalls, [['WORKTREE', 'src/file.txt']]);
    disposable.dispose();
    provider.dispose();
});

test('comment mutations stay in their owning UUID bucket and branch threads remain pinned', async () => {
    const workspace = temporaryDirectory('offline-review-comments-');
    installVscodeMock(workspace);
    const oldTarget = 'b'.repeat(40);
    const newTarget = 'c'.repeat(40);
    const baseCommit = 'a'.repeat(40);
    const { LocalPrManager } = built('services/localPrManager');
    const { StorageService } = built('storage/storageService');
    const { ReviewCommentController } = built('comments/commentController');
    const {
        getDiffDocumentUri,
        getFileDiffUris,
    } = built('git/gitService');
    const { ChangedFilesProvider } = built('views/changedFilesProvider');
    const manager = new LocalPrManager({
        async getCommitHash(ref) {
            if (ref === 'main') {
                return baseCommit;
            }
            if (ref === 'feature-a') {
                return oldTarget;
            }
            return 'd'.repeat(40);
        },
    }, workspace);
    const reviewA = await manager.createBranchReview('main', 'feature-a', false);
    const reviewB = await manager.createBranchReview('main', 'feature-b', false);
    const storage = new StorageService(manager);
    const plan = (review, targetCommit) => ({
        kind: 'branch',
        reviewId: review.id,
        baseBranch: review.baseBranch,
        targetBranch: review.targetBranch,
        baseCommit,
        mergeBaseCommit: baseCommit,
        targetCommit,
        left: { kind: 'git', ref: baseCommit },
        right: { kind: 'git', ref: targetCommit },
    });
    const planA = plan(reviewA, oldTarget);
    const planB = plan(reviewB, 'd'.repeat(40));
    const controller = new ReviewCommentController(storage);
    controller.setReviewableFiles(['old.txt']);
    controller.loadAllThreads(planA);
    const uriA = getDiffDocumentUri(planA.right, 'old.txt', 'modified', reviewA.id);
    const range = new vscode.Range(4, 0, 4, 0);
    const pendingReviewId = controller.captureNewThreadReviewId(uriA, 'old.txt');
    controller.createThread(uriA, range, 'owned by A', 'old.txt');
    const ownedThread = vscode.__createdCommentThreads.at(-1);
    let commentsA = storage.loadCommentsForReview(reviewA.id);
    assert.equal(commentsA.threads.length, 1);
    assert.deepEqual(commentsA.threads[0].target, {
        kind: 'git',
        ref: oldTarget,
        filePath: 'old.txt',
    });

    manager.setActiveReview(reviewB.id);
    controller.setReviewableFiles(['old.txt']);
    controller.loadAllThreads(planB);
    assert.throws(() => controller.createThread(
        uriA,
        range,
        'late pending A submission',
        'old.txt',
        undefined,
        pendingReviewId
    ), /prepared diff target|active review changed/);

    // Already-persisted stale UI actions deliberately mutate A by captured UUID.
    controller.addReply(ownedThread, 'reply in A');
    const editingComment = ownedThread.comments[0];
    editingComment.mode = vscode.CommentMode.Editing;
    ownedThread.comments = [...ownedThread.comments];
    controller.saveEditedComment(ownedThread, editingComment, 'edited in A');
    controller.resolveThread(ownedThread);
    controller.deleteComment(ownedThread, ownedThread.comments[1]);
    commentsA = storage.loadCommentsForReview(reviewA.id);
    const commentsB = storage.loadCommentsForReview(reviewB.id);
    assert.equal(commentsA.threads[0].comments.length, 1);
    assert.equal(commentsA.threads[0].comments[0].body, 'edited in A');
    assert.equal(commentsA.threads[0].state, 'resolved');
    assert.equal(commentsB.threads.length, 0);

    // Stable UI-to-storage identity prevents an external insertion from making
    // a delayed confirmation delete whichever comment moved into the old index.
    const staleSelectedComment = ownedThread.comments[0];
    const selectedCommentId = commentsA.threads[0].comments[0].id;
    commentsA.threads[0].comments.unshift({
        id: 'concurrent-comment',
        body: 'inserted concurrently',
        author: 'external',
        timestamp: new Date().toISOString(),
    });
    storage.saveCommentsForReview(reviewA.id, commentsA);
    controller.deleteComment(ownedThread, staleSelectedComment);
    commentsA = storage.loadCommentsForReview(reviewA.id);
    assert.equal(
        commentsA.threads[0].comments.some(comment => comment.id === selectedCommentId),
        false
    );
    assert.deepEqual(
        commentsA.threads[0].comments.map(comment => comment.id),
        ['concurrent-comment']
    );

    const refreshedPlan = plan(reviewA, newTarget);
    const beforePinnedLoad = vscode.__createdCommentThreads.length;
    controller.setReviewableFiles(['renamed.txt']);
    controller.loadAllThreads(refreshedPlan);
    const pinnedThreads = vscode.__createdCommentThreads.slice(beforePinnedLoad);
    assert.equal(pinnedThreads.length, 1);
    const pinnedParams = new URLSearchParams(pinnedThreads[0].uri.query);
    assert.equal(pinnedParams.get('ref'), oldTarget);
    assert.equal(pinnedParams.get('reviewId'), reviewA.id);
    assert.equal(pinnedThreads[0].uri.path, '/old.txt');
    const currentUri = getDiffDocumentUri(
        refreshedPlan.right,
        'renamed.txt',
        'modified',
        reviewA.id
    );
    controller.loadThreadsForFile(currentUri, 'renamed.txt', refreshedPlan);
    assert.equal(vscode.__createdCommentThreads.length, beforePinnedLoad + 1);

    const gitService = {
        async getChangedFiles() {
            return [{ status: 'renamed', filePath: 'renamed.txt', oldFilePath: 'old.txt' }];
        },
        async getCommitsForDiff() {
            return [];
        },
        getFileDiffUris,
    };
    const provider = new ChangedFilesProvider(gitService, storage, manager);
    assert.equal(await provider.refresh(refreshedPlan), true);
    provider.getChildren();
    assert.equal(provider.getAllFileItems()[0].commentCount, 0);

    storage.addThread(
        reviewA.id,
        { kind: 'git', ref: newTarget, filePath: 'renamed.txt' },
        'renamed.txt',
        0,
        0,
        'current comment',
        'test'
    );
    assert.equal(await provider.refresh(refreshedPlan), true);
    provider.getChildren();
    assert.equal(provider.getAllFileItems()[0].commentCount, 1);

    provider.dispose();
    controller.dispose();
    manager.dispose();
});
