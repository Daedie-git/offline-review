'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { after, afterEach, test } = require('node:test');
const { installVscodeMock, vscode } = require('./helpers/vscodeMock');

const projectRoot = path.resolve(__dirname, '..');
const compiledRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'offline-reanchor-build-'));
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

function planFor(review, root, targetCommit = 'b'.repeat(40), mergeBase = 'a'.repeat(40)) {
    return {
        kind: 'branch',
        reviewId: review.id,
        worktreeRoot: root,
        baseBranch: review.baseBranch,
        targetBranch: review.targetBranch,
        baseCommit: mergeBase,
        mergeBaseCommit: mergeBase,
        targetCommit,
        left: { kind: 'git', ref: mergeBase },
        right: { kind: 'git', ref: targetCommit },
    };
}

async function reviewFixture(mode = 'branch') {
    const workspace = temporaryDirectory('offline-reanchor-review-');
    installVscodeMock(workspace);
    const { LocalPrManager } = built('services/localPrManager');
    const { StorageService } = built('storage/storageService');
    const manager = new LocalPrManager({
        async getCommitHash(ref) {
            return ref === 'main' ? 'a'.repeat(40) : 'b'.repeat(40);
        },
    }, workspace);
    const review = mode === 'branch'
        ? await manager.createBranchReview('main', 'feature', false)
        : await manager.createUncommittedReview('feature', false);
    manager.setActiveReview(review.id);
    return { workspace, manager, review, storage: new StorageService(manager) };
}

test('exact line-sequence resolver covers exact, moved, ambiguous, overlapping, and line endings', () => {
    const { resolveExactLineSequence, splitExactLines } = built('lineSequenceResolver');
    const cases = [
        ['current', 'a\nb\nc', 'b', 1, 1, 'current', [[1, 1]]],
        ['moved single', 'x\na\nb', 'a', 0, 0, 'reanchored', [[1, 1]]],
        ['moved multiline', 'x\na\nb\ny', 'a\nb', 0, 1, 'reanchored', [[1, 2]]],
        ['not found', 'a\nb', 'z', 0, 0, 'notFound', []],
        ['duplicate', 'a\nx\na', 'a', 1, 1, 'ambiguous', [[0, 0], [2, 2]]],
        ['overlapping', 'a\na\na', 'a\na', 3, 4, 'ambiguous', [[0, 1], [1, 2]]],
        ['authored wins duplicates', 'a\nx\na', 'a', 0, 0, 'current', [[0, 0], [2, 2]]],
        ['out of range unique', 'a\nb', 'b', 20, 20, 'reanchored', [[1, 1]]],
        ['CRLF', 'x\r\na\r\nb', 'a\nb', 0, 1, 'reanchored', [[1, 2]]],
        ['lone CR', 'x\ra\rb', 'a\nb', 0, 1, 'reanchored', [[1, 2]]],
        ['empty anchor', 'a\n\n', '', 1, 1, 'current', [[1, 1], [2, 2]]],
        ['terminal blanks', 'a\n\n', '\n', 1, 2, 'current', [[1, 2]]],
    ];
    for (const [name, content, anchor, start, end, status, matches] of cases) {
        const actual = resolveExactLineSequence(content, anchor, start, end);
        assert.equal(actual.status, status, name);
        assert.deepEqual(
            actual.matches.map(match => [match.startLine, match.endLine]),
            matches,
            name
        );
    }
    assert.deepEqual(splitExactLines('a\r\nb\rc\n'), ['a', 'b', 'c', '']);
});

test('review comments v2 accepts legacy and optional anchors, rejects non-strings, and never upgrades', async () => {
    const { workspace, review, storage } = await reviewFixture();
    const target = { kind: 'git', ref: 'b'.repeat(40), filePath: 'src/file.ts' };
    const legacy = storage.addThread(
        review.id, target, 'src/file.ts', 0, 0, 'legacy', 'tester'
    );
    const anchored = storage.addThread(
        review.id, target, 'src/file.ts', 1, 1, 'anchored', 'tester', 'exact line'
    );
    const filePath = path.join(
        workspace, '.vscode/local-reviews/reviews', review.id, 'comments.json'
    );
    const bytes = fs.readFileSync(filePath);
    let loaded = storage.loadCommentsForReview(review.id);
    assert.equal(loaded.version, 2);
    assert.equal(loaded.threads.find(thread => thread.id === legacy.id).sourceAnchor, undefined);
    assert.equal(loaded.threads.find(thread => thread.id === anchored.id).sourceAnchor, 'exact line');
    assert.deepEqual(fs.readFileSync(filePath), bytes);

    const malformed = JSON.parse(bytes.toString('utf8'));
    malformed.threads[0].sourceAnchor = 17;
    fs.writeFileSync(filePath, JSON.stringify(malformed));
    loaded = storage.loadCommentsForReview(review.id);
    assert.equal(loaded.version, 2);
    assert.deepEqual(loaded.threads, []);
    assert.equal(fs.readFileSync(filePath, 'utf8'), JSON.stringify(malformed));
});

test('branch projections reconstruct immutable Git anchors and resolve only same-path same-side candidates', async () => {
    const { workspace, review, storage } = await reviewFixture();
    const oldTarget = '1'.repeat(40);
    const newTarget = '2'.repeat(40);
    const oldBase = '3'.repeat(40);
    const newBase = '4'.repeat(40);
    const addLegacy = (filePath, target, start = 0, end = start) => storage.addThread(
        review.id, target, filePath, start, end, filePath, 'tester'
    );
    const moved = addLegacy('moved.ts', { kind: 'git', ref: oldTarget, filePath: 'moved.ts' });
    const duplicate = addLegacy(
        'duplicate.ts',
        { kind: 'git', ref: oldTarget, filePath: 'duplicate.ts' },
        1
    );
    const missing = addLegacy('missing.ts', { kind: 'git', ref: oldTarget, filePath: 'missing.ts' });
    const original = addLegacy('original.ts', {
        kind: 'git', ref: oldBase, side: 'original', filePath: 'original.ts',
    });
    const unavailable = addLegacy('unavailable.ts', {
        kind: 'git', ref: '9'.repeat(40), filePath: 'unavailable.ts',
    });
    const renamed = addLegacy('old-name.ts', {
        kind: 'git', ref: oldTarget, filePath: 'old-name.ts',
    });
    const persisted = storage.addThread(
        review.id,
        { kind: 'git', ref: '8'.repeat(40), filePath: 'persisted.ts' },
        'persisted.ts', 0, 0, 'persisted', 'tester', 'persisted anchor'
    );

    const contents = new Map([
        [`${oldTarget}:moved.ts`, 'needle\n'],
        [`${newTarget}:moved.ts`, 'before\nneedle\nafter\n'],
        [`${oldTarget}:duplicate.ts`, 'x\ndup\n'],
        [`${newTarget}:duplicate.ts`, 'dup\nx\ndup\n'],
        [`${oldTarget}:missing.ts`, 'gone\n'],
        [`${newTarget}:missing.ts`, 'different\n'],
        [`${oldBase}:original.ts`, 'base anchor\n'],
        [`${newBase}:original.ts`, 'x\nbase anchor\n'],
        [`${oldTarget}:old-name.ts`, 'old\n'],
        [`${newTarget}:new-name.ts`, 'old\n'],
        [`${newTarget}:persisted.ts`, 'x\npersisted anchor\n'],
    ]);
    const calls = [];
    const gitService = {
        async getFileContentResult(document, filePath) {
            calls.push(`${document.ref}:${filePath}`);
            const content = contents.get(`${document.ref}:${filePath}`);
            return content === undefined
                ? { status: 'unavailable' }
                : { status: 'available', content };
        },
    };
    const { ReviewAnchorResolver } = built('comments/reviewAnchorResolver');
    const resolver = new ReviewAnchorResolver(gitService, storage);
    const plan = planFor(review, workspace, newTarget, newBase);
    const files = [
        'moved.ts', 'duplicate.ts', 'missing.ts', 'persisted.ts', 'unavailable.ts',
    ].map(filePath => ({ status: 'modified', filePath }));
    files.push({ status: 'deleted', filePath: 'original.ts' });
    files.push({ status: 'renamed', filePath: 'new-name.ts', oldFilePath: 'old-name.ts' });
    const commentsPath = path.join(
        workspace, '.vscode/local-reviews/reviews', review.id, 'comments.json'
    );
    const before = fs.readFileSync(commentsPath);
    const state = await resolver.prepare(plan, files);
    assert.deepEqual(fs.readFileSync(commentsPath), before, 'projection reads never write');
    const byId = new Map(state.projections.map(projection => [projection.thread.id, projection]));
    assert.deepEqual(
        [byId.get(moved.id).anchorStatus, byId.get(moved.id).effectiveStartLine],
        ['reanchored', 1]
    );
    assert.equal(byId.get(duplicate.id).anchorStatus, 'ambiguous');
    assert.equal(byId.get(duplicate.id).matches.length, 2);
    assert.equal(byId.get(missing.id).anchorStatus, 'notFound');
    assert.deepEqual(
        [byId.get(original.id).side, byId.get(original.id).anchorStatus,
            byId.get(original.id).effectiveStartLine],
        ['original', 'reanchored', 1]
    );
    assert.equal(byId.get(unavailable.id).anchorStatus, 'unavailable');
    assert.equal(byId.get(renamed.id).anchorStatus, 'unavailable');
    assert.equal(byId.get(persisted.id).anchorStatus, 'reanchored');
    assert.equal(
        calls.includes(`${'8'.repeat(40)}:persisted.ts`),
        false,
        'persisted anchors take precedence over historical blob reads'
    );
    assert.equal(
        calls.filter(call => call === `${newTarget}:moved.ts`).length,
        1,
        'candidate content is cached per prepare call'
    );
});

test('worktree projections move persisted anchors and retire anchorless legacy placement after HEAD advances', async () => {
    const { workspace, review, storage } = await reviewFixture('worktree');
    const head = 'a'.repeat(40);
    const nextHead = 'b'.repeat(40);
    const firstPlanId = '11111111-1111-4111-8111-111111111111';
    const secondPlanId = '22222222-2222-4222-8222-222222222222';
    const worktreePlan = (headCommit, planId) => ({
        kind: 'worktree',
        reviewId: review.id,
        worktreeRoot: workspace,
        branch: 'feature',
        headCommit,
        planId,
        left: { kind: 'git', ref: headCommit },
        right: {
            kind: 'worktree', reviewId: review.id, headCommit, planId,
            worktreeRoot: workspace,
        },
    });
    const oldTarget = {
        kind: 'worktree', reviewId: review.id, headCommit: head,
        planId: firstPlanId, filePath: 'dirty.ts',
    };
    const anchored = storage.addThread(
        review.id, oldTarget, 'dirty.ts', 0, 0, 'anchored', 'tester', 'move me'
    );
    const legacy = storage.addThread(
        review.id, oldTarget, 'dirty.ts', 1, 1, 'legacy', 'tester'
    );
    const ambiguous = storage.addThread(
        review.id, oldTarget, 'dirty.ts', 3, 3, 'ambiguous', 'tester', 'duplicate'
    );
    let content = 'before\nmove me\nduplicate\nx\nduplicate\n';
    const gitService = {
        async getFileContentResult() {
            return { status: 'available', content };
        },
    };
    const { ReviewAnchorResolver } = built('comments/reviewAnchorResolver');
    const resolver = new ReviewAnchorResolver(gitService, storage);
    const sameHeadPlan = worktreePlan(head, secondPlanId);
    let state = await resolver.prepare(sameHeadPlan, [{ status: 'modified', filePath: 'dirty.ts' }]);
    let byId = new Map(state.projections.map(projection => [projection.thread.id, projection]));
    assert.deepEqual(
        [byId.get(anchored.id).anchorStatus, byId.get(anchored.id).effectiveStartLine],
        ['reanchored', 1]
    );
    assert.deepEqual(
        [byId.get(legacy.id).anchorStatus, byId.get(legacy.id).effectiveStartLine],
        ['legacyCurrent', 1]
    );
    assert.equal(byId.get(ambiguous.id).anchorStatus, 'ambiguous');
    assert.equal(new URL(byId.get(anchored.id).currentPlanUri).searchParams.get('planId'), secondPlanId);
    assert.equal(new URL(byId.get(anchored.id).currentPlanUri).searchParams.get('worktreeRoot'), workspace);

    content = 'later\nmove me\n';
    state = await resolver.prepare(
        worktreePlan(nextHead, '33333333-3333-4333-8333-333333333333'),
        [{ status: 'modified', filePath: 'dirty.ts' }]
    );
    byId = new Map(state.projections.map(projection => [projection.thread.id, projection]));
    assert.equal(byId.get(anchored.id).anchorStatus, 'reanchored');
    assert.equal(byId.get(legacy.id).anchorStatus, 'unavailable');
});

test('controller, changed files, decorations, and tool consume the same applied projection', async () => {
    const { workspace, manager, review, storage } = await reviewFixture('worktree');
    const head = 'a'.repeat(40);
    const planId = '44444444-4444-4444-8444-444444444444';
    const plan = {
        kind: 'worktree', reviewId: review.id, worktreeRoot: workspace,
        branch: 'feature', headCommit: head, planId,
        left: { kind: 'git', ref: head },
        right: {
            kind: 'worktree', reviewId: review.id, headCommit: head, planId,
            worktreeRoot: workspace,
        },
    };
    storage.addThread(
        review.id,
        { kind: 'worktree', reviewId: review.id, headCommit: head, planId,
            filePath: 'src/file.ts' },
        'src/file.ts', 0, 0, 'move', 'tester', 'anchor'
    );
    const gitService = {
        getSelectedWorktreeRoot: () => workspace,
        async getFileContentResult() {
            return { status: 'available', content: 'before\nanchor\n' };
        },
        async getChangedFiles() {
            return [{ status: 'modified', filePath: 'src/file.ts' }];
        },
        async getCommitsForDiff() { return []; },
        getFileDiffUris(currentPlan, file) {
            const { getFileDiffUris } = built('git/gitService');
            return getFileDiffUris(currentPlan, file);
        },
        async getCurrentBranch() { return 'feature'; },
    };
    const { ReviewAnchorResolver } = built('comments/reviewAnchorResolver');
    const resolver = new ReviewAnchorResolver(gitService, storage);
    const state = await resolver.prepare(plan, [{ status: 'modified', filePath: 'src/file.ts' }]);
    resolver.applyPreparedState(state);

    const { ReviewCommentController } = built('comments/commentController');
    const controller = new ReviewCommentController(storage, resolver);
    controller.setReviewableFiles(['src/file.ts']);
    controller.loadAllThreads(plan, state);
    const rendered = vscode.__createdCommentThreads.at(-1);
    assert.equal(rendered.range.start.line, 1);
    assert.equal(new URL(rendered.uri.toString()).searchParams.get('planId'), planId);

    const originalLoadForReview = storage.loadCommentsForReview.bind(storage);
    let uiStorageLoads = 0;
    storage.loadCommentsForReview = (...args) => {
        uiStorageLoads++;
        return originalLoadForReview(...args);
    };
    const { ChangedFilesProvider } = built('views/changedFilesProvider');
    const changedFiles = new ChangedFilesProvider(gitService, storage, manager, resolver);
    assert.equal(await changedFiles.refresh(plan), true);
    changedFiles.getChildren();
    assert.equal(changedFiles.getAllFileItems()[0].commentCount, 1);

    const { ReviewFileDecorationProvider } = built('decorations/fileDecorationProvider');
    const decorations = new ReviewFileDecorationProvider(storage, gitService, resolver);
    const workspaceUri = vscode.Uri.file(path.join(workspace, 'src/file.ts'));
    const decoration = decorations.provideFileDecoration(workspaceUri);
    assert.equal(decoration.badge, '1');
    assert.equal(uiStorageLoads, 0, 'applied decoration/tree queries never reload comments.json');

    controller.resolveThread(rendered);
    changedFiles.fireChange();
    changedFiles.getChildren();
    assert.equal(changedFiles.getAllFileItems()[0].commentCount, 0);
    assert.equal(decorations.provideFileDecoration(workspaceUri), undefined);
    controller.unresolveThread(rendered);
    changedFiles.fireChange();
    changedFiles.getChildren();
    assert.equal(changedFiles.getAllFileItems()[0].commentCount, 1);
    assert.equal(decorations.provideFileDecoration(workspaceUri).badge, '1');
    assert.equal(uiStorageLoads, 0, 'in-process state mutations update the projection');
    storage.loadCommentsForReview = originalLoadForReview;

    const { LocalReviewTool } = built('tools/localReviewTool');
    const tool = new LocalReviewTool(gitService, manager, storage, resolver);
    const result = await tool.invoke({ input: { filePath: 'src/file.ts' } }, undefined);
    const payload = JSON.parse(result.content[0].value);
    assert.equal(payload.threads[0].anchorStatus, 'reanchored');
    assert.equal(payload.threads[0].effectiveStartLine, 1);
    assert.equal(payload.threads[0].currentPlanPlacement.startLine, 1);
    const unavailableTool = new LocalReviewTool(gitService, manager, storage);
    const unavailable = JSON.parse((await unavailableTool.invoke({ input: {} }, undefined)).content[0].value);
    assert.equal(unavailable.threads[0].anchorStatus, 'unavailable');
    const substring = JSON.parse((await tool.invoke({ input: { filePath: 'file.ts' } }, undefined)).content[0].value);
    assert.equal(substring.threads.length, 0, 'filtering is exact rather than substring-based');

    controller.deleteComment(rendered, rendered.comments[0]);
    assert.equal(resolver.getAppliedState(plan).projections.length, 0);
    uiStorageLoads = 0;
    storage.loadCommentsForReview = (...args) => {
        uiStorageLoads++;
        return originalLoadForReview(...args);
    };
    changedFiles.fireChange();
    changedFiles.getChildren();
    assert.equal(changedFiles.getAllFileItems()[0].commentCount, 0);
    assert.equal(decorations.provideFileDecoration(workspaceUri), undefined);
    assert.equal(uiStorageLoads, 0, 'deleted projection stays removed without a UI disk read');
    storage.loadCommentsForReview = originalLoadForReview;
});

test('a delayed superseded anchor preparation cannot replace the latest applied projection', async () => {
    const { workspace, review, storage } = await reviewFixture();
    storage.addThread(
        review.id,
        { kind: 'git', ref: '1'.repeat(40), filePath: 'file.ts' },
        'file.ts', 0, 0, 'comment', 'tester', 'anchor'
    );
    let releaseSlow;
    const slowCanFinish = new Promise(resolve => { releaseSlow = resolve; });
    const gitService = {
        async getFileContentResult(document) {
            if (document.ref === '2'.repeat(40)) {
                await slowCanFinish;
                return { status: 'available', content: 'anchor\n' };
            }
            return { status: 'available', content: 'x\nanchor\n' };
        },
    };
    const { ReviewAnchorResolver } = built('comments/reviewAnchorResolver');
    const resolver = new ReviewAnchorResolver(gitService, storage);
    let generation = 0;
    const prepareAndApply = async plan => {
        const ownGeneration = ++generation;
        const state = await resolver.prepare(plan, [{ status: 'modified', filePath: 'file.ts' }]);
        if (ownGeneration === generation) {
            resolver.applyPreparedState(state);
            return true;
        }
        return false;
    };
    const slowPlan = planFor(review, workspace, '2'.repeat(40));
    const latestPlan = planFor(review, workspace, '3'.repeat(40));
    const slow = prepareAndApply(slowPlan);
    assert.equal(await prepareAndApply(latestPlan), true);
    releaseSlow();
    assert.equal(await slow, false);
    assert.equal(resolver.getAppliedState().plan.targetCommit, latestPlan.targetCommit);
    assert.equal(resolver.getAppliedState().projections[0].effectiveStartLine, 1);
});

test('Reviews header Clear All remains contributed and branch webview clear buttons remain removed', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'));
    assert.equal(manifest.contributes.menus['view/title'].some(item =>
        item.command === 'localPrReview.clearAllReviews'
        && item.when === 'view == localPrReview.localPrs'
    ), true);
    const webview = fs.readFileSync(
        path.join(projectRoot, 'src/views/branchSelectorWebviewProvider.ts'), 'utf8'
    );
    assert.equal(webview.includes('clearActiveBtn'), false);
    assert.equal(webview.includes('clearAllBtn'), false);
});
