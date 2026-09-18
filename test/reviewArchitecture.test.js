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
execFileSync(process.execPath, [require.resolve('typescript/bin/tsc'),
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

test('review storage targets only offline-reviews without legacy migration', async () => {
    const workspace = temporaryDirectory('offline-review-storage-name-');
    installVscodeMock(workspace);
    const legacyRegistry = `${JSON.stringify({
        version: 2,
        reviews: [{
            id: '11111111-1111-4111-8111-111111111111',
            mode: 'branch',
            baseBranch: 'legacy-base',
            targetBranch: 'legacy-target',
            sourceCommit: 'a'.repeat(40),
            targetCommit: 'b'.repeat(40),
            createdAt: new Date(0).toISOString(),
        }],
        activeMode: 'branch',
    }, null, 2)}\n`;
    const legacyPaths = [
        '.vscode/local-reviews/registry.json',
        '.vscode/offline-review/registry.json',
    ];
    for (const legacyPath of legacyPaths) {
        write(workspace, legacyPath, legacyRegistry);
    }

    const { LocalPrManager } = built('services/localPrManager');
    const manager = new LocalPrManager({
        async getCommitHash(ref) {
            return ref === 'main' ? 'c'.repeat(40) : 'd'.repeat(40);
        },
    }, workspace);
    assert.deepEqual(manager.listReviews(), []);
    const review = await manager.createBranchReview('main', 'feature');

    const canonicalRegistry = path.join(
        workspace, '.vscode', 'offline-reviews', 'registry.json'
    );
    assert.equal(fs.existsSync(canonicalRegistry), true);
    assert.equal(JSON.parse(fs.readFileSync(canonicalRegistry, 'utf8')).reviews[0].id, review.id);
    for (const legacyPath of legacyPaths) {
        assert.equal(fs.readFileSync(path.join(workspace, legacyPath), 'utf8'), legacyRegistry);
    }
    manager.dispose();
});

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
    write(repository, '.vscode/offline-reviews/registry.json', '{"version":2}\n');
    git(repository, 'add', 'staged.txt', '.vscode/offline-reviews/registry.json');
    write(repository, '.vscode/offline-reviews/reviews/review/comments.json', '{}\n');
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

test('linked worktree selection drives both modes and prepared URIs retain their root', async () => {
    const repository = temporaryDirectory('offline-review-worktrees-');
    const externalContainer = temporaryDirectory('offline-review-linked-parent-');
    const external = path.join(externalContainer, 'linked checkout with spaces');
    installVscodeMock(repository);
    git(repository, 'init', '-b', 'main');
    git(repository, 'config', 'user.name', 'Offline Review Test');
    git(repository, 'config', 'user.email', 'offline-review@example.invalid');
    write(repository, 'base.txt', 'base\n');
    const baseCommit = commit(repository, 'base');
    git(repository, 'worktree', 'add', '-b', 'linked-feature', external);
    write(external, 'external-commit.txt', 'committed in linked worktree\n');
    const externalCommit = commit(external, 'linked worktree commit');
    write(external, 'external-dirty.txt', 'uncommitted in linked worktree\n');
    write(repository, 'local-dirty.txt', 'uncommitted in Local\n');

    const { GitService, parseDiffDocumentUri, parseWorktreeList } = built('git/gitService');
    const service = new GitService({ subscriptions: [] });
    assert.equal(service.getSelectedWorktreeRoot(), repository, 'Local is the session default');

    const listed = await service.listWorktrees();
    assert.equal(listed.length, 2);
    assert.equal(listed.find(worktree => worktree.isLocal).root, repository);
    const linked = listed.find(worktree => worktree.root === external);
    assert.deepEqual(
        { branch: linked.branch, detached: linked.detached },
        { branch: 'linked-feature', detached: false }
    );

    let selectionEvents = 0;
    service.onDidChangeWorktreeSelection(() => selectionEvents++);
    await assert.rejects(
        service.selectWorktree(path.join(externalContainer, 'vanished worktree')),
        /no longer linked/
    );
    await service.selectWorktree(external);
    assert.equal(selectionEvents, 1);
    assert.equal(await service.getCurrentBranch(), 'linked-feature');

    const branchReview = {
        id: '33333333-3333-4333-8333-333333333333',
        mode: 'branch',
        baseBranch: 'main',
        targetBranch: 'linked-feature',
        sourceCommit: baseCommit,
        targetCommit: externalCommit,
        createdAt: new Date(0).toISOString(),
    };
    const branchPlan = await service.prepareDiffPlan(branchReview);
    assert.equal(branchPlan.worktreeRoot, external);
    assert.deepEqual(
        (await service.getChangedFiles(branchPlan)).map(change => change.filePath),
        ['external-commit.txt']
    );

    const uncommittedReview = {
        id: '44444444-4444-4444-8444-444444444444',
        mode: 'uncommitted',
        branch: 'linked-feature',
        sourceCommit: externalCommit,
        targetCommit: externalCommit,
        createdAt: new Date(0).toISOString(),
    };
    const externalPlan = await service.prepareDiffPlan(uncommittedReview);
    assert.deepEqual(
        (await service.getChangedFiles(externalPlan)).map(change => change.filePath),
        ['external-dirty.txt']
    );
    const externalUri = service.getFileDiffUris(externalPlan, {
        status: 'added',
        filePath: 'external-dirty.txt',
    }).right;
    assert.equal(parseDiffDocumentUri(externalUri).document.worktreeRoot, external);

    await service.selectWorktree(repository);
    assert.equal(await service.getCurrentBranch(), 'main');
    const parsedOldUri = parseDiffDocumentUri(externalUri);
    assert.equal(
        await service.getFileContent(parsedOldUri.document, parsedOldUri.filePath),
        'uncommitted in linked worktree\n'
    );

    const synthetic = [
        `worktree ${path.join(externalContainer, 'path with spaces')}`,
        `HEAD ${'a'.repeat(40)}`,
        'detached',
        '',
        `worktree ${path.join(externalContainer, 'stale checkout')}`,
        `HEAD ${'b'.repeat(40)}`,
        'prunable gitdir file points to non-existent location',
        '',
        '',
    ].join('\0');
    assert.deepEqual(parseWorktreeList(synthetic, repository), [{
        root: path.join(externalContainer, 'path with spaces'),
        headCommit: 'a'.repeat(40),
        branch: undefined,
        detached: true,
        isLocal: false,
    }]);

    // A registered path replaced by an unrelated repository must not remain an
    // authorization token for old virtual documents or live Git operations.
    await service.selectWorktree(external);
    fs.rmSync(external, { recursive: true, force: true });
    fs.mkdirSync(external, { recursive: true });
    git(external, 'init', '-b', 'unrelated');
    assert.equal(await service.isLinkedWorktreeRoot(external), false);
    await assert.rejects(service.getCurrentBranch(), /no longer linked/);
    assert.equal(service.getSelectedWorktreeRoot(), repository);
    await assert.rejects(service.getChangedFiles(externalPlan), /no longer linked/);
    await service.checkoutBranch('main');
    assert.equal(git(external, 'branch', '--show-current'), 'unrelated');
    assert.equal(
        await service.getFileContent(parsedOldUri.document, parsedOldUri.filePath),
        ''
    );

    const reactivatedService = new GitService({ subscriptions: [] });
    assert.equal(reactivatedService.getSelectedWorktreeRoot(), repository);
});

test('overlapping worktree selections keep the latest requested checkout', async () => {
    const local = temporaryDirectory('offline-review-selection-local-');
    const firstRoot = temporaryDirectory('offline-review-selection-first-');
    const latestRoot = temporaryDirectory('offline-review-selection-latest-');
    installVscodeMock(local);

    const { GitService } = built('git/gitService');
    const service = new GitService({ subscriptions: [] });
    const info = root => ({
        root,
        headCommit: 'a'.repeat(40),
        branch: path.basename(root),
        detached: false,
        isLocal: root === local,
    });
    const worktrees = [info(local), info(firstRoot), info(latestRoot)];
    let releaseFirst;
    let firstListStarted;
    const firstStarted = new Promise(resolve => { firstListStarted = resolve; });
    const firstCanFinish = new Promise(resolve => { releaseFirst = resolve; });
    let listCalls = 0;
    service.listWorktrees = async () => {
        listCalls++;
        if (listCalls === 1) {
            firstListStarted();
            await firstCanFinish;
        }
        return worktrees;
    };
    service.validateLinkedWorktreeRoot = async () => true;

    const firstSelection = service.selectWorktree(firstRoot);
    await firstStarted;
    const latestSelection = service.selectWorktree(latestRoot);
    await latestSelection;
    releaseFirst();
    await firstSelection;

    assert.equal(service.getSelectedWorktreeRoot(), latestRoot);
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
        path.join(workspace, '.vscode', 'offline-reviews', 'registry.json'),
        'utf8'
    ));
    assert.equal(registry.reviews.length, 2);
    manager.dispose();
});

test('clearing reviews cancels older pending creations without blocking a new request', async () => {
    const workspace = temporaryDirectory('offline-review-clear-race-');
    installVscodeMock(workspace);
    let releaseCommits;
    const commitsReady = new Promise(resolve => { releaseCommits = resolve; });
    let waitForCommits = true;
    const managerGitService = {
        async getCommitHash(ref) {
            if (waitForCommits) {
                await commitsReady;
            }
            return ref === 'main' ? 'a'.repeat(40) : 'b'.repeat(40);
        },
    };
    const { LocalPrManager } = built('services/localPrManager');
    const manager = new LocalPrManager(managerGitService, workspace);
    const staleCreation = manager.createBranchReview('main', 'feature', false);
    manager.clearAllReviews();
    waitForCommits = false;
    releaseCommits();
    await assert.rejects(staleCreation, /superseded by a clear operation/);
    assert.deepEqual(manager.listReviews(), []);

    const freshReview = await manager.createBranchReview('main', 'feature', false);
    assert.equal(manager.listReviews().length, 1);
    assert.equal(manager.getReviewById(freshReview.id).targetBranch, 'feature');
    manager.setActiveReview(freshReview.id);
    manager.setPreferredBaseBranch('main');
    manager.clearAllReviews();
    assert.deepEqual(manager.listReviews(), []);
    assert.equal(manager.getActiveReview(), undefined);
    assert.equal(manager.getActiveMode(), 'branch');
    assert.equal(manager.getPreferredBaseBranch(), 'main');
    manager.dispose();

    const restored = new LocalPrManager(managerGitService, workspace);
    assert.deepEqual(restored.listReviews(), []);
    assert.equal(restored.getActiveReview(), undefined);
    assert.equal(restored.getActiveMode(), 'branch');
    assert.equal(restored.getPreferredBaseBranch(), 'main');
    restored.dispose();
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
        worktreeRoot: '/tmp/offline-review-provider-test',
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
    // Actions must work even before the host requests the tree's children.
    assert.equal(provider.getAllFileItems()[0].fileChange.filePath, 'fast.txt');
    const sections = provider.getChildren();
    assert.equal(provider.getChildren()[0], sections[0]);
    assert.equal(provider.getAllExpandableItems()[0], sections[0]);
    provider.fireChange();
    assert.equal(provider.getAllFileItems()[0].fileChange.filePath, 'fast.txt');
    provider.setFileReviewed('fast.txt', true);
    provider.fireChange();
    assert.equal(provider.getAllFileItems()[0].checkboxState, vscode.TreeItemCheckboxState.Checked);
    const plan = provider.getDiffPlan();
    const pendingRefresh = provider.refresh(reviewA);
    provider.clearReviewProgress();
    assert.equal(await pendingRefresh, false);
    assert.equal(provider.getDiffPlan(), plan);
    assert.deepEqual(provider.getAllFilePaths(), ['fast.txt']);
    assert.deepEqual(provider.getPreparedState().reviewedFiles, []);
    assert.equal(provider.getAllFileItems()[0].checkboxState, vscode.TreeItemCheckboxState.Unchecked);
    provider.dispose();
});

test('file comment picker is scoped, sorted, includes resolved threads and rejects stale selections', async () => {
    installVscodeMock('/tmp/offline-review-picker');
    const { ReviewCommentController } = built('comments/commentController');
    const controller = new ReviewCommentController({}, {});
    const uri = vscode.Uri.file('/tmp/selected.txt');
    const makeThread = (line, state, body, target = uri) => ({
        uri: target,
        range: new vscode.Range(line, 0, line, 0),
        state,
        comments: [{ body }],
        dispose() {},
    });
    const first = makeThread(2, vscode.CommentThreadState.Resolved, { value: 'First\ncomment' });
    const last = makeThread(20, vscode.CommentThreadState.Unresolved, 'Last comment');
    controller.threads.set('last', last);
    controller.threads.set('other', makeThread(0, 0, 'Other', vscode.Uri.file('/tmp/other.txt')));
    controller.threads.set('first', first);
    const originalPicker = vscode.window.showQuickPick;
    try {
        vscode.window.showQuickPick = async items => {
            assert.deepEqual(items.map(item => item.label), ['First comment', 'Last comment']);
            assert.match(items[0].description, /Line 3 - resolved/);
            return items[0];
        };
        assert.equal(await controller.pickFileComment(uri), first);
        vscode.window.showQuickPick = async () => undefined;
        assert.equal(await controller.pickFileComment(uri), undefined);
        vscode.window.showQuickPick = async items => {
            controller.loadAllThreads();
            return items[0];
        };
        assert.equal(await controller.pickFileComment(uri), undefined);
        vscode.window.showQuickPick = async () => assert.fail('Empty files must not open a picker');
        assert.equal(await controller.pickFileComment(uri), undefined);
    } finally {
        vscode.window.showQuickPick = originalPicker;
        controller.dispose();
    }
});

test('activation retries survive startup and deleting reviews preserves a refreshable comparison', async () => {
    const repository = temporaryDirectory('offline-review-activation-');
    installVscodeMock(repository);
    git(repository, 'init', '-b', 'main');
    git(repository, 'config', 'user.name', 'Offline Review Test');
    git(repository, 'config', 'user.email', 'offline-review@example.invalid');
    write(repository, 'file.txt', 'base\n');
    const base = commit(repository, 'base');
    git(repository, 'checkout', '-b', 'feature');
    write(repository, 'file.txt', 'changed\n');
    const target = commit(repository, 'feature');
    const { LocalPrManager } = built('services/localPrManager');
    const manager = new LocalPrManager({
        async getCommitHash(ref) { return ref === 'main' ? base : target; },
    }, repository);
    await manager.createBranchReview('main', 'feature');
    manager.dispose();

    const { GitService } = built('git/gitService');
    const { ReviewTransitionCoordinator } = built('services/reviewTransitionCoordinator');
    const originalPrepare = ReviewTransitionCoordinator.prototype.prepareStable;
    const commands = new Map();
    const trees = new Map();
    const restorers = [];
    const replace = (object, key, value) => {
        const previous = object[key];
        object[key] = value;
        restorers.push(() => { object[key] = previous; });
    };
    const disposable = () => new vscode.Disposable();
    replace(GitService.prototype, 'initialize', async function () {
        await this.initializeLocalWorktreeRoot();
        return true;
    });
    let preparations = 0;
    replace(ReviewTransitionCoordinator.prototype, 'prepareStable', function (options) {
        return ++preparations === 1
            ? Promise.resolve({ status: 'retry', attempts: 3 })
            : originalPrepare.call(this, options);
    });
    replace(vscode, 'RelativePattern', class {});
    replace(vscode.commands, 'registerCommand', (name, handler) => {
        commands.set(name, handler);
        return disposable();
    });
    replace(vscode.window, 'registerFileDecorationProvider', disposable);
    replace(vscode.window, 'onDidChangeActiveTextEditor', disposable);
    replace(vscode.window, 'createTreeView', (name, options) => {
        trees.set(name, options.treeDataProvider);
        return { dispose() {}, onDidChangeCheckboxState: disposable, onDidChangeVisibility: disposable };
    });
    replace(vscode.window, 'registerWebviewViewProvider', () => {
        assert.ok(commands.has('localPrReview.reviewActiveBranch'));
        return disposable();
    });
    replace(vscode.workspace, 'registerTextDocumentContentProvider', disposable);
    replace(vscode.workspace, 'onDidSaveTextDocument', disposable);
    replace(vscode.workspace, 'createFileSystemWatcher', () => ({
        dispose() {}, onDidChange: disposable, onDidCreate: disposable, onDidDelete: disposable,
    }));
    replace(vscode.window, 'showWarningMessage', async (_message, _options, choice) => choice);
    const context = { subscriptions: [], extensionUri: vscode.Uri.file(projectRoot) };
    try {
        await built('extension').activate(context);
        const provider = trees.get('localPrReview.changedFiles');
        const deadline = Date.now() + 5000;
        while (!provider.getDiffPlan() && Date.now() < deadline) {
            await new Promise(resolve => setTimeout(resolve, 25));
        }
        assert.deepEqual(provider.getAllFilePaths(), ['file.txt']);
        for (const command of ['deleteReview', 'clearActiveReview', 'clearAllReviews']) {
            provider.setFileReviewed('file.txt', true);
            const plan = provider.getDiffPlan();
            await commands.get(`localPrReview.${command}`)();
            assert.equal(provider.getDiffPlan(), plan);
            assert.deepEqual(provider.getAllFilePaths(), ['file.txt']);
            assert.deepEqual(provider.getPreparedState().reviewedFiles, []);
            const registryPath = path.join(repository, '.vscode/offline-reviews/registry.json');
            assert.deepEqual(JSON.parse(fs.readFileSync(registryPath, 'utf8')).reviews, []);
            await commands.get('localPrReview.refreshFiles')();
            assert.deepEqual(provider.getAllFilePaths(), ['file.txt']);
            assert.deepEqual(JSON.parse(fs.readFileSync(registryPath, 'utf8')).reviews, []);
            await commands.get('localPrReview.reviewActiveBranch')();
        }

        write(repository, 'file.txt', 'local change\n');
        await commands.get('localPrReview.reviewUncommitted')();
        const oldItem = provider.getAllFileItems()[0];
        replace(vscode.workspace, 'textDocuments', [{
            uri: oldItem.rightUri,
            lineCount: 2,
            lineAt(line) { return { text: line === 0 ? 'local change' : '' }; },
        }]);
        await commands.get('localPrReview.addComment')({
            thread: { uri: oldItem.rightUri, range: new vscode.Range(0, 0, 0, 0), comments: [], dispose() {} },
            text: 'navigate after refresh',
        });
        await commands.get('localPrReview.refreshFiles')();
        const currentItem = provider.getAllFileItems()[0];
        assert.notEqual(currentItem.rightUri.toString(), oldItem.rightUri.toString());
        replace(vscode.window, 'activeTextEditor', { document: { uri: oldItem.rightUri } });
        let picked = false;
        replace(vscode.window, 'showQuickPick', async items => {
            assert.equal(items[0].label, 'navigate after refresh');
            picked = true;
            return items[0];
        });
        let revealed;
        replace(vscode.window, 'visibleTextEditors', [{
            document: { uri: currentItem.rightUri },
            revealRange(range) { revealed = range; },
        }]);
        const diffs = [];
        replace(vscode.commands, 'executeCommand', async (command, ...args) => {
            if (command === 'vscode.diff') {
                diffs.push(args);
                return;
            }
            return commands.get(command)(...args);
        });
        await commands.get('localPrReview.goToFileComment')();
        assert.equal(picked, true);
        assert.equal(diffs[0][1].toString(), currentItem.rightUri.toString());
        assert.equal(revealed.start.line, 0);
    } finally {
        for (const subscription of context.subscriptions.reverse()) subscription.dispose();
        for (const restore of restorers.reverse()) restore();
    }
});

test('worktree URIs carry prepared identity and file refresh invalidates every matching open document', async () => {
    installVscodeMock('/tmp/offline-review-uri-test');
    const {
        getDiffDocumentUri,
        parseDiffDocumentUri,
    } = built('git/gitService');
    const { GitFileContentProvider } = built('git/gitFileContentProvider');
    const { getLiveWorktreeUri } = built('language/virtualDocLanguageFeatures');
    const reviewA = '77777777-7777-4777-8777-777777777777';
    const reviewB = '88888888-8888-4888-8888-888888888888';
    const headA = 'a'.repeat(40);
    const headB = 'b'.repeat(40);
    const planA = '99999999-9999-4999-8999-999999999999';
    const planB = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const planC = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const worktreeRoot = path.resolve('/tmp/offline-review-uri-test');
    const uriA = getDiffDocumentUri(
        { kind: 'worktree', reviewId: reviewA, headCommit: headA, planId: planA, worktreeRoot },
        'src/file.txt',
        'modified',
        reviewA
    );
    const uriB = getDiffDocumentUri(
        { kind: 'worktree', reviewId: reviewB, headCommit: headA, planId: planB, worktreeRoot },
        'src/file.txt',
        'modified',
        reviewB
    );
    const uriNewHead = getDiffDocumentUri(
        { kind: 'worktree', reviewId: reviewA, headCommit: headB, planId: planC, worktreeRoot },
        'src/file.txt',
        'modified',
        reviewA
    );
    const uriNewPlan = getDiffDocumentUri(
        { kind: 'worktree', reviewId: reviewA, headCommit: headA, planId: planB, worktreeRoot },
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
        worktreeRoot,
        document: {
            kind: 'worktree',
            reviewId: reviewA,
            headCommit: headA,
            planId: planA,
            worktreeRoot,
        },
    });

    const otherFile = getDiffDocumentUri(
        { kind: 'worktree', reviewId: reviewA, headCommit: headA, planId: planA, worktreeRoot },
        'src/other.txt',
        'modified',
        reviewA
    );
    const immutable = getDiffDocumentUri(
        { kind: 'git', ref: headA },
        'src/file.txt',
        'modified',
        reviewA,
        worktreeRoot
    );
    assert.equal(getLiveWorktreeUri(immutable), undefined);
    assert.equal(
        getLiveWorktreeUri(uriA).fsPath,
        path.join(worktreeRoot, 'src/file.txt')
    );
    vscode.workspace.textDocuments = [uriA, uriB, uriNewHead, uriNewPlan, otherFile, immutable]
        .map(uri => ({ uri }));
    const contentCalls = [];
    const provider = new GitFileContentProvider({
        async getFileContent(document, filePath) {
            contentCalls.push([document, filePath]);
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
    assert.deepEqual(contentCalls, [[{
        kind: 'worktree',
        reviewId: reviewA,
        headCommit: headA,
        planId: planA,
        worktreeRoot,
    }, 'src/file.txt']]);
    disposable.dispose();
    provider.dispose();
});

test('virtual language navigation safely restores matching branch snapshots', async () => {
    const workspace = path.resolve('/tmp/offline-review-language-test');
    installVscodeMock(workspace);
    const { getDiffDocumentUri } = built('git/gitService');
    const { registerVirtualDocLanguageFeatures } = built(
        'language/virtualDocLanguageFeatures'
    );
    const reviewId = '77777777-7777-4777-8777-777777777777';
    const commitId = 'a'.repeat(40);
    const sourceText = 'fn definition() {}\nfn caller() { definition(); }\n';
    const textDocument = (uri, text = sourceText, version = 1) => ({
        uri,
        version,
        lineCount: text.split('\n').length,
        getText() { return text; },
        lineAt(line) {
            const value = text.split('\n')[line];
            return { text: value, range: { end: { character: value.length } } };
        },
    });
    const branchUri = getDiffDocumentUri(
        { kind: 'git', ref: commitId },
        'src/main.rs',
        'modified',
        reviewId,
        workspace
    );
    const realUri = vscode.Uri.file(path.join(workspace, 'src/main.rs'));
    let realDocument = textDocument(realUri);
    const opened = [];
    vscode.workspace.openTextDocument = async uri => {
        opened.push(uri.toString());
        return realDocument;
    };
    const commandCalls = [];
    const definition = { uri: vscode.Uri.file(path.join(workspace, 'src/lib.rs')) };
    vscode.commands.executeCommand = async (...args) => {
        commandCalls.push(args);
        return [definition];
    };
    const context = { subscriptions: [] };
    registerVirtualDocLanguageFeatures(context, {
        async isLinkedWorktreeRoot(root) { return root === workspace; },
    });
    const providers = vscode.__registeredLanguageProviders;
    assert.equal(providers.definitions.length, 1);
    assert.equal(providers.typeDefinitions.length, 1);
    assert.equal(providers.implementations.length, 1);
    assert.equal(providers.references.length, 1);
    assert.equal(providers.hovers.length, 1);
    assert.deepEqual(providers.definitions[0].selector, { scheme: 'git-local-review' });

    const token = { isCancellationRequested: false };
    const position = new vscode.Position(1, 22);
    const virtualDocument = textDocument(branchUri);
    const result = await providers.definitions[0].provider.provideDefinition(
        virtualDocument,
        position,
        token
    );
    assert.deepEqual(result, [definition]);
    assert.deepEqual(opened, [realUri.toString()]);
    assert.equal(commandCalls.length, 1);
    assert.equal(commandCalls[0][0], 'vscode.executeDefinitionProvider');
    assert.equal(commandCalls[0][1].toString(), realUri.toString());
    assert.equal(commandCalls[0][2], position);

    commandCalls.length = 0;
    realDocument = textDocument(realUri, `${sourceText}// dirty\n`);
    assert.equal(await providers.definitions[0].provider.provideDefinition(
        virtualDocument,
        position,
        token
    ), undefined);
    assert.equal(commandCalls.length, 0, 'mismatched snapshots never reach the real provider');

    const originalUri = getDiffDocumentUri(
        { kind: 'git', ref: commitId },
        'src/main.rs',
        'original',
        reviewId,
        workspace
    );
    realDocument = textDocument(realUri);
    assert.equal(await providers.definitions[0].provider.provideDefinition(
        textDocument(originalUri),
        position,
        token
    ), undefined);

    const worktreeUri = getDiffDocumentUri({
        kind: 'worktree',
        reviewId,
        headCommit: commitId,
        planId: '99999999-9999-4999-8999-999999999999',
        worktreeRoot: workspace,
    }, 'src/main.rs', 'modified', reviewId);
    assert.deepEqual(await providers.definitions[0].provider.provideDefinition(
        textDocument(worktreeUri),
        position,
        token
    ), [definition]);

    vscode.commands.executeCommand = async () => {
        realDocument.version++;
        return [definition];
    };
    assert.equal(await providers.definitions[0].provider.provideDefinition(
        virtualDocument,
        position,
        token
    ), undefined, 'a real-document change invalidates an in-flight result');
});

test('same-HEAD worktree comments remain attached after a document-cache refresh', async () => {
    const workspace = temporaryDirectory('offline-review-worktree-comments-');
    installVscodeMock(workspace);
    const head = 'a'.repeat(40);
    const firstPlanId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
    const secondPlanId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
    const { LocalPrManager } = built('services/localPrManager');
    const { StorageService } = built('storage/storageService');
    const { ReviewCommentController } = built('comments/commentController');
    const { ReviewAnchorResolver } = built('comments/reviewAnchorResolver');
    const { getDiffDocumentUri, getFileDiffUris } = built('git/gitService');
    const { ChangedFilesProvider } = built('views/changedFilesProvider');
    const manager = new LocalPrManager({
        async getCommitHash() { return head; },
    }, workspace);
    const review = await manager.createUncommittedReview('feature', false);
    manager.setActiveReview(review.id);
    const storage = new StorageService(manager);
    const anchorResolver = new ReviewAnchorResolver({
        async getFileContentResult() {
            return { status: 'available', content: 'dirty line\n' };
        },
    }, storage);
    const controller = new ReviewCommentController(storage, anchorResolver);
    const plan = planId => ({
        kind: 'worktree',
        reviewId: review.id,
        worktreeRoot: workspace,
        branch: 'feature',
        headCommit: head,
        planId,
        left: { kind: 'git', ref: head },
        right: {
            kind: 'worktree',
            reviewId: review.id,
            headCommit: head,
            planId,
            worktreeRoot: workspace,
        },
    });
    const firstPlan = plan(firstPlanId);
    anchorResolver.applyPreparedState(await anchorResolver.prepare(firstPlan, [{
        status: 'modified', filePath: 'dirty.txt',
    }]));
    controller.setReviewableFiles(['dirty.txt']);
    controller.loadAllThreads(firstPlan);
    vscode.workspace.openTextDocument = async uri => ({
        uri,
        lineCount: 1,
        lineAt() { return { text: 'dirty line', range: { end: { character: 10 } } }; },
    });
    const firstUri = getDiffDocumentUri(
        firstPlan.right,
        'dirty.txt',
        'modified',
        review.id,
        workspace
    );
    await controller.createThread(
        firstUri,
        new vscode.Range(0, 0, 0, 0),
        'survives refresh',
        'dirty.txt'
    );
    assert.equal(
        storage.loadCommentsForReview(review.id).threads[0].sourceAnchor,
        'dirty line'
    );

    const secondPlan = plan(secondPlanId);
    anchorResolver.applyPreparedState(await anchorResolver.prepare(secondPlan, [{
        status: 'modified', filePath: 'dirty.txt',
    }]));
    const threadCountBefore = vscode.__createdCommentThreads.length;
    controller.loadAllThreads(secondPlan);
    const refreshedThread = vscode.__createdCommentThreads.at(-1);
    assert.equal(vscode.__createdCommentThreads.length, threadCountBefore + 1);
    assert.equal(new URLSearchParams(refreshedThread.uri.query).get('planId'), secondPlanId);

    const provider = new ChangedFilesProvider({
        async getChangedFiles() {
            return [{ status: 'modified', filePath: 'dirty.txt' }];
        },
        async getCommitsForDiff() { return []; },
        getFileDiffUris,
    }, storage, manager, anchorResolver);
    assert.equal(await provider.refresh(secondPlan), true);
    provider.getChildren();
    assert.equal(provider.getAllFileItems()[0].commentCount, 1);

    provider.dispose();
    controller.dispose();
    manager.dispose();
});

test('deleted files accept comments on the immutable original side', async () => {
    const workspace = temporaryDirectory('offline-review-deleted-comments-');
    installVscodeMock(workspace);
    const baseCommit = 'a'.repeat(40);
    const targetCommit = 'b'.repeat(40);
    const { LocalPrManager } = built('services/localPrManager');
    const { StorageService } = built('storage/storageService');
    const { ReviewCommentController } = built('comments/commentController');
    const { ReviewAnchorResolver } = built('comments/reviewAnchorResolver');
    const { getDiffDocumentUri, getFileDiffUris } = built('git/gitService');
    const { ChangedFilesProvider } = built('views/changedFilesProvider');
    const manager = new LocalPrManager({
        async getCommitHash(ref) {
            return ref === 'main' ? baseCommit : targetCommit;
        },
    }, workspace);
    const review = await manager.createBranchReview('main', 'feature', false);
    manager.setActiveReview(review.id);
    const storage = new StorageService(manager);
    const anchorResolver = new ReviewAnchorResolver({
        async getFileContentResult() {
            return { status: 'available', content: 'first\ndeleted line\n' };
        },
    }, storage);
    const controller = new ReviewCommentController(storage, anchorResolver);
    const plan = {
        kind: 'branch',
        reviewId: review.id,
        worktreeRoot: workspace,
        baseBranch: 'main',
        targetBranch: 'feature',
        baseCommit,
        mergeBaseCommit: baseCommit,
        targetCommit,
        left: { kind: 'git', ref: baseCommit },
        right: { kind: 'git', ref: targetCommit },
    };
    anchorResolver.applyPreparedState(await anchorResolver.prepare(plan, [{
        status: 'deleted', filePath: 'deleted.txt',
    }]));
    controller.setReviewableFiles(['deleted.txt'], ['deleted.txt']);
    controller.loadAllThreads(plan);
    const leftUri = getDiffDocumentUri(
        plan.left,
        'deleted.txt',
        'original',
        review.id,
        workspace
    );
    const rightUri = getDiffDocumentUri(
        plan.right,
        'deleted.txt',
        'modified',
        review.id,
        workspace
    );
    const documentFor = uri => ({
        uri,
        lineCount: 2,
        lineAt(line) {
            const text = line === 0 ? 'first' : 'deleted line';
            return { text, range: { end: { character: text.length } } };
        },
    });
    vscode.workspace.openTextDocument = async uri => documentFor(uri);
    assert.equal(
        controller.controller.commentingRangeProvider
            .provideCommentingRanges(documentFor(leftUri)).length,
        1
    );
    assert.equal(
        controller.controller.commentingRangeProvider
            .provideCommentingRanges(documentFor(rightUri)).length,
        0
    );
    assert.equal(controller.captureNewThreadReviewId(leftUri, 'deleted.txt'), review.id);
    assert.throws(
        () => controller.captureNewThreadReviewId(rightUri, 'deleted.txt'),
        /prepared diff target/
    );
    await controller.createThread(
        leftUri,
        new vscode.Range(1, 0, 1, 0),
        'comment on deleted line',
        'deleted.txt'
    );
    const comments = storage.loadCommentsForReview(review.id);
    assert.deepEqual(comments.threads[0].target, {
        kind: 'git',
        ref: baseCommit,
        side: 'original',
        filePath: 'deleted.txt',
    });
    storage.addThread(
        review.id,
        { kind: 'git', ref: targetCommit, filePath: 'deleted.txt' },
        'deleted.txt',
        0,
        0,
        'wrong side',
        'test'
    );

    const provider = new ChangedFilesProvider({
        async getChangedFiles() {
            return [{ status: 'deleted', filePath: 'deleted.txt' }];
        },
        async getCommitsForDiff() { return []; },
        getFileDiffUris,
    }, storage, manager, anchorResolver);
    assert.equal(await provider.refresh(plan), true);
    provider.getChildren();
    const deletedItem = provider.getAllFileItems()[0];
    assert.equal(deletedItem.commentCount, 1);
    assert.equal(deletedItem.commentUri.toString(), deletedItem.leftUri.toString());
    assert.equal(
        new URLSearchParams(vscode.__createdCommentThreads.at(-1).uri.query).get('side'),
        'original'
    );

    const worktreeReview = await manager.createUncommittedReview('feature', false);
    manager.setActiveReview(worktreeReview.id);
    const worktreePlanId = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
    const worktreePlan = {
        kind: 'worktree',
        reviewId: worktreeReview.id,
        worktreeRoot: workspace,
        branch: 'feature',
        headCommit: targetCommit,
        planId: worktreePlanId,
        left: { kind: 'git', ref: targetCommit },
        right: {
            kind: 'worktree',
            reviewId: worktreeReview.id,
            headCommit: targetCommit,
            planId: worktreePlanId,
            worktreeRoot: workspace,
        },
    };
    anchorResolver.applyPreparedState(await anchorResolver.prepare(worktreePlan, [{
        status: 'deleted', filePath: 'removed-worktree.txt',
    }]));
    controller.setReviewableFiles(['removed-worktree.txt'], ['removed-worktree.txt']);
    controller.loadAllThreads(worktreePlan);
    const worktreeLeftUri = getDiffDocumentUri(
        worktreePlan.left,
        'removed-worktree.txt',
        'original',
        worktreeReview.id,
        workspace
    );
    await controller.createThread(
        worktreeLeftUri,
        new vscode.Range(0, 0, 0, 0),
        'deleted before commit',
        'removed-worktree.txt'
    );
    assert.deepEqual(
        storage.loadCommentsForReview(worktreeReview.id).threads[0].target,
        {
            kind: 'git',
            ref: targetCommit,
            side: 'original',
            filePath: 'removed-worktree.txt',
        }
    );

    provider.dispose();
    controller.dispose();
    manager.dispose();
});

test('comment mutations stay UUID-owned while historical placement stays diagnostic', async () => {
    const workspace = temporaryDirectory('offline-review-comments-');
    installVscodeMock(workspace);
    const oldTarget = 'b'.repeat(40);
    const newTarget = 'c'.repeat(40);
    const baseCommit = 'a'.repeat(40);
    const { LocalPrManager } = built('services/localPrManager');
    const { StorageService } = built('storage/storageService');
    const { ReviewCommentController } = built('comments/commentController');
    const { ReviewAnchorResolver } = built('comments/reviewAnchorResolver');
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
        worktreeRoot: workspace,
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
    const anchorResolver = new ReviewAnchorResolver({
        async getFileContentResult(_document, filePath) {
            return {
                status: 'available',
                content: filePath === 'renamed.txt' ? 'current\n' : 'one\ntwo\nthree\nfour\nowned\n',
            };
        },
    }, storage);
    const controller = new ReviewCommentController(storage, anchorResolver);
    anchorResolver.applyPreparedState(await anchorResolver.prepare(planA, [{
        status: 'modified', filePath: 'old.txt',
    }]));
    controller.setReviewableFiles(['old.txt']);
    controller.loadAllThreads(planA);
    const uriA = getDiffDocumentUri(
        planA.right,
        'old.txt',
        'modified',
        reviewA.id,
        planA.worktreeRoot
    );
    const range = new vscode.Range(4, 0, 4, 0);
    vscode.workspace.openTextDocument = async uri => ({
        uri,
        lineCount: 5,
        lineAt(line) {
            const text = ['one', 'two', 'three', 'four', 'owned'][line];
            return { text, range: { end: { character: text.length } } };
        },
    });
    const pendingReviewId = controller.captureNewThreadReviewId(uriA, 'old.txt');
    await controller.createThread(uriA, range, 'owned by A', 'old.txt');
    const ownedThread = vscode.__createdCommentThreads.at(-1);
    let commentsA = storage.loadCommentsForReview(reviewA.id);
    assert.equal(commentsA.threads.length, 1);
    assert.deepEqual(commentsA.threads[0].target, {
        kind: 'git',
        ref: oldTarget,
        filePath: 'old.txt',
    });

    let releasePendingDocument;
    let pendingDocumentStarted;
    const pendingStarted = new Promise(resolve => { pendingDocumentStarted = resolve; });
    const pendingDocument = new Promise(resolve => { releasePendingDocument = resolve; });
    vscode.workspace.openTextDocument = async uri => {
        pendingDocumentStarted();
        await pendingDocument;
        return {
            uri,
            lineCount: 5,
            lineAt(line) {
                const text = ['one', 'two', 'three', 'four', 'owned'][line];
                return { text, range: { end: { character: text.length } } };
            },
        };
    };
    const delayedSubmission = controller.createThread(
        uriA, range, 'delayed owned by A', 'old.txt', undefined, pendingReviewId
    );
    await pendingStarted;

    manager.setActiveReview(reviewB.id);
    anchorResolver.applyPreparedState(await anchorResolver.prepare(planB, [{
        status: 'modified', filePath: 'old.txt',
    }]));
    controller.setReviewableFiles(['old.txt']);
    controller.loadAllThreads(planB);
    releasePendingDocument();
    await assert.rejects(delayedSubmission, /active review changed|prepared diff target/);
    await assert.rejects(controller.createThread(
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
    // Host updates the comment body in place before invoking save.
    editingComment.body = 'edited in A';
    ownedThread.comments = [...ownedThread.comments];
    controller.saveEditedComment(
        ownedThread,
        editingComment,
        typeof editingComment.body === 'string'
            ? editingComment.body
            : editingComment.body.value
    );
    assert.equal(ownedThread.comments[0].mode, vscode.CommentMode.Preview);

    // Discard restores the last stored body and leaves Preview mode.
    const draft = ownedThread.comments[0];
    draft.mode = vscode.CommentMode.Editing;
    draft.body = 'discard me';
    controller.discardCommentEdits(ownedThread);
    assert.equal(ownedThread.comments[0].mode, vscode.CommentMode.Preview);
    assert.equal(
        typeof ownedThread.comments[0].body === 'string'
            ? ownedThread.comments[0].body
            : ownedThread.comments[0].body.value,
        'edited in A'
    );

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
    anchorResolver.applyPreparedState(await anchorResolver.prepare(refreshedPlan, [{
        status: 'renamed', filePath: 'renamed.txt', oldFilePath: 'old.txt',
    }]));
    const beforeRefreshedLoad = vscode.__createdCommentThreads.length;
    controller.setReviewableFiles(['renamed.txt']);
    controller.loadAllThreads(refreshedPlan);
    assert.equal(
        vscode.__createdCommentThreads.length,
        beforeRefreshedLoad,
        'historical placement is diagnostic only and renames are not followed'
    );
    const currentUri = getDiffDocumentUri(
        refreshedPlan.right,
        'renamed.txt',
        'modified',
        reviewA.id,
        refreshedPlan.worktreeRoot
    );
    controller.loadThreadsForFile(currentUri, 'renamed.txt', refreshedPlan);
    assert.equal(vscode.__createdCommentThreads.length, beforeRefreshedLoad);

    const gitService = {
        async getChangedFiles() {
            return [{ status: 'renamed', filePath: 'renamed.txt', oldFilePath: 'old.txt' }];
        },
        async getCommitsForDiff() {
            return [];
        },
        getFileDiffUris,
    };
    const provider = new ChangedFilesProvider(
        gitService, storage, manager, anchorResolver
    );
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
    anchorResolver.applyPreparedState(await anchorResolver.prepare(refreshedPlan, [{
        status: 'renamed', filePath: 'renamed.txt', oldFilePath: 'old.txt',
    }]));
    assert.equal(await provider.refresh(refreshedPlan), true);
    provider.getChildren();
    assert.equal(provider.getAllFileItems()[0].commentCount, 1);

    provider.dispose();
    controller.dispose();
    manager.dispose();
});

test('save/cancel command args distinguish reply box from in-place edit', () => {
    const { isCommentReply, commentBodyText } = built('extension');
    const reply = {
        thread: { comments: [] },
        text: 'new reply body',
    };
    // Host unmarshals comments/comment/context to the Comment itself, with
    // body already rewritten to the editor text (not a CommentReply).
    const editingComment = {
        body: 'edited body',
        mode: vscode.CommentMode.Editing,
        author: { name: 'tester' },
        __offlineReviewId: 'review-1',
        __offlineThreadId: 'thread-1',
        __offlineCommentId: 'comment-1',
    };
    const markdownComment = {
        body: new vscode.MarkdownString('markdown body'),
        mode: vscode.CommentMode.Preview,
        author: { name: 'tester' },
    };

    assert.equal(isCommentReply(reply), true);
    assert.equal(isCommentReply(editingComment), false);
    assert.equal(isCommentReply(markdownComment), false);
    assert.equal(isCommentReply(undefined), false);
    assert.equal(commentBodyText(editingComment), 'edited body');
    assert.equal(commentBodyText(markdownComment), 'markdown body');
});

test('package contributes distinct thread vs in-place edit comment menus', () => {
    const packageJson = JSON.parse(
        fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8')
    );
    const menus = packageJson.contributes.menus;
    const threadContext = menus['comments/commentThread/context'];
    const commentContext = menus['comments/comment/context'];

    const reviewThread = threadContext.filter(entry =>
        entry.when.includes('commentController == localPrReview')
    );
    assert.equal(
        reviewThread.some(entry =>
            entry.command === 'localPrReview.addComment'
            && entry.when.includes('commentThreadIsEmpty')
        ),
        true
    );
    assert.equal(
        reviewThread.some(entry =>
            entry.command === 'localPrReview.replyComment'
            && entry.when.includes('!commentThreadIsEmpty')
        ),
        true
    );
    assert.equal(
        reviewThread.some(entry => entry.command === 'localPrReview.saveComment'),
        false,
        'Save must not appear on the new-comment / reply form'
    );
    assert.equal(
        commentContext.some(entry =>
            entry.command === 'localPrReview.saveComment'
            && entry.when.includes('localPrReview')
        ),
        true,
        'Save must appear on the in-place edit form'
    );
});
