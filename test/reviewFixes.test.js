'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { execFileSync, spawn } = require('node:child_process');
const { after, afterEach, test } = require('node:test');
const { installVscodeMock, vscode } = require('./helpers/vscodeMock');

const projectRoot = path.resolve(__dirname, '..');
const directories = [];
function temporaryDirectory() {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'offline-review-fixes-'));
    directories.push(directory);
    return directory;
}
const compiledRoot = temporaryDirectory();
directories.pop();
execFileSync(process.execPath, [require.resolve('typescript/bin/tsc'),
    '-p', projectRoot, '--outDir', compiledRoot, '--declaration', 'false', '--sourceMap', 'false',
], { cwd: projectRoot, stdio: 'pipe' });
const built = relative => require(path.join(compiledRoot, relative));
after(() => fs.rmSync(compiledRoot, { recursive: true, force: true }));
afterEach(() => {
    for (const directory of directories.splice(0)) {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('registry transactions preserve other windows, session ownership, and deletions', async () => {
    const workspace = temporaryDirectory();
    installVscodeMock(workspace);
    const { LocalPrManager } = built('services/localPrManager');
    const git = { async getCommitHash() { return 'a'.repeat(40); } };
    const a = new LocalPrManager(git, workspace);
    const b = new LocalPrManager(git, workspace);
    const first = await a.createBranchReview('main', 'first');
    const second = await b.createUncommittedReview('second');
    const read = () => new LocalPrManager(git, workspace);
    assert.deepEqual(read().listReviews().map(r => r.id), [first.id, second.id]);

    a.setReviewedFiles(['first.ts']);
    assert.equal(a.getActiveReview().id, first.id, 'another window cannot switch the active session');
    assert.equal(a.getActiveMode(), 'branch');
    b.setReviewedFiles(['second.ts']);
    a.updateBranchReviewFallbackCommits(first.id, 'b'.repeat(40), 'c'.repeat(40));
    let latest = read();
    assert.deepEqual(latest.getReviewById(first.id).reviewedFiles, ['first.ts']);
    assert.deepEqual(latest.getReviewById(second.id).reviewedFiles, ['second.ts']);
    assert.equal(latest.getReviewById(first.id).targetCommit, 'c'.repeat(40));

    a.deactivateReview();
    assert.equal(read().getActiveReview().id, second.id, 'deactivation does not clear another window');
    a.deleteReview(second.id);
    b.setReviewedFiles(['must-not-resurrect.ts']);
    b.setPreferredBaseBranch('release');
    latest = read();
    assert.deepEqual(latest.listReviews().map(r => r.id), [first.id]);
    assert.deepEqual(latest.getReviewById(first.id).reviewedFiles, ['first.ts']);
    assert.equal(latest.getPreferredBaseBranch(), 'release');
    assert.equal(b.getActiveReview(), undefined);

    const registryPath = path.join(workspace, '.vscode/offline-reviews/registry.json');
    const original = fs.readFileSync(registryPath);
    const originalRename = fs.renameSync;
    fs.renameSync = (source, target) => {
        if (target === registryPath) throw new Error('injected registry publication failure');
        return originalRename(source, target);
    };
    try {
        assert.throws(() => b.setPreferredBaseBranch('must-not-persist'), /injected/);
    } finally {
        fs.renameSync = originalRename;
    }
    assert.deepEqual(fs.readFileSync(registryPath), original);
    assert.equal(b.getPreferredBaseBranch(), 'release');
    assert.equal(fs.existsSync(path.join(path.dirname(registryPath), '.registry.lock')), false);
    fs.writeFileSync(registryPath, '{malformed');
    assert.throws(() => b.setPreferredBaseBranch('main'), /refusing to overwrite/);
    assert.equal(fs.readFileSync(registryPath, 'utf8'), '{malformed');
});

test('independent processes serialize registry creation and deduplicate identities', { timeout: 20000 }, async () => {
    const workspace = temporaryDirectory();
    installVscodeMock(workspace);
    const script = `
        const [project, compiled, workspace, label] = process.argv.slice(1);
        require(project + '/test/helpers/vscodeMock').installVscodeMock(workspace);
        const { LocalPrManager } = require(compiled + '/services/localPrManager');
        const manager = new LocalPrManager({ async getCommitHash() { return 'a'.repeat(40); } }, workspace);
        process.once('message', async () => {
            try {
                await manager.createBranchReview('main', 'shared', false);
                for (let index = 0; index < 4; index++) {
                    await manager.createBranchReview('main', label + index, false);
                }
                process.disconnect();
            } catch (error) { console.error(error); process.exit(1); }
        });
        process.send('ready');
    `;
    const workers = ['a', 'b'].map(label => {
        const child = spawn(process.execPath, ['-e', script, projectRoot, compiledRoot, workspace, label], {
            stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
            windowsHide: true,
        });
        let stderr = '';
        child.stderr.on('data', chunk => { stderr += chunk; });
        const ready = new Promise((resolve, reject) => {
            child.once('message', resolve);
            child.once('error', reject);
            child.once('exit', code => { if (code !== 0) reject(new Error(stderr)); });
        });
        const done = new Promise((resolve, reject) => {
            child.once('error', reject);
            child.once('exit', code => code === 0 ? resolve() : reject(new Error(stderr)));
        });
        return { child, ready, done };
    });
    try {
        await Promise.all(workers.map(w => w.ready));
        workers.forEach(w => w.child.send('go'));
        await Promise.all(workers.map(w => w.done));
    } finally {
        for (const worker of workers) if (worker.child.exitCode === null) worker.child.kill();
        await Promise.allSettled(workers.map(w => w.done));
    }
    const { LocalPrManager } = built('services/localPrManager');
    const reviews = new LocalPrManager({}, workspace).listReviews();
    assert.equal(reviews.length, 9);
    assert.equal(reviews.filter(r => r.targetBranch === 'shared').length, 1);
});

test('navigation rebinds refreshed diff tabs only within the current review and worktree', () => {
    const workspace = temporaryDirectory();
    installVscodeMock(workspace);
    const { ChangedFilesProvider } = built('views/changedFilesProvider');
    const { getFileDiffUris, getDiffDocumentUri } = built('git/gitService');
    const reviewId = '11111111-1111-4111-8111-111111111111';
    const oldId = '22222222-2222-4222-8222-222222222222';
    const newId = '33333333-3333-4333-8333-333333333333';
    const plan = {
        kind: 'worktree', reviewId, worktreeRoot: workspace, branch: 'main',
        headCommit: 'a'.repeat(40), planId: newId,
        left: { kind: 'git', ref: 'a'.repeat(40) },
        right: { kind: 'worktree', reviewId, worktreeRoot: workspace, headCommit: 'a'.repeat(40), planId: newId },
    };
    const provider = new ChangedFilesProvider({ getFileDiffUris }, {}, { getReviewedFiles: () => [] });
    const files = [
        { status: 'modified', filePath: 'src/file.ts' },
        { status: 'renamed', filePath: 'src/new.ts', oldFilePath: 'src/old.ts' },
        { status: 'deleted', filePath: 'src/deleted.ts' },
    ];
    provider.applyPreparedState({ plan, files, commits: [], reviewedFiles: [] });
    const oldRight = getDiffDocumentUri({ ...plan.right, planId: oldId }, files[0].filePath, 'modified');
    const item = provider.getFileItemForUri(oldRight);
    assert.equal(item.diffPlan, plan);
    assert.notEqual(item.rightUri.toString(), oldRight.toString());
    assert.equal(provider.getFileItemForUri(item.rightUri), item);
    assert.equal(provider.getFileItemForUri(vscode.Uri.file(path.join(workspace, files[0].filePath))), item);
    for (const file of files.slice(1)) {
        const oldLeft = getDiffDocumentUri({ kind: 'git', ref: 'b'.repeat(40) },
            file.oldFilePath ?? file.filePath, 'original', reviewId, workspace);
        assert.equal(provider.getFileItemForUri(oldLeft).fileChange.filePath, file.filePath);
    }
    const forged = overrides => getDiffDocumentUri({ ...plan.right, planId: oldId, ...overrides },
        files[0].filePath, 'modified');
    assert.equal(provider.getFileItemForUri(forged({ reviewId: oldId })), undefined);
    assert.equal(provider.getFileItemForUri(forged({ worktreeRoot: path.join(workspace, 'other') })), undefined);
    assert.equal(provider.getFileItemForUri(vscode.Uri.parse('git-local-review://authority/src/file.ts?ref=WORKTREE')), undefined);
    provider.clear();
    assert.equal(provider.getFileItemForUri(oldRight), undefined);
    provider.dispose();
});

test('suggestion HTML preserves closing tags as data and the composer remains functional', () => {
    installVscodeMock(projectRoot);
    const { SuggestChangePanel } = built('views/suggestChangePanel');
    for (const originalCode of ['plain text', '</script>', '</ScRiPt><script>alert(1)</script>', '<!--\n"<&\n']) {
        const html = SuggestChangePanel.prototype.getHtml.call({ originalCode }, {});
        const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi)];
        assert.equal(scripts.length, 1);
        const elements = new Map();
        const messages = [];
        const document = { getElementById(id) {
            if (!elements.has(id)) elements.set(id, { value: '', addEventListener(event, callback) { this[event] = callback; } });
            return elements.get(id);
        } };
        new vm.Script(scripts[0][1]).runInNewContext({
            document, acquireVsCodeApi: () => ({ postMessage: message => messages.push(message) }),
        });
        assert.equal(elements.get('original').value, originalCode);
        assert.equal(elements.get('suggested').value, originalCode);
        elements.get('btnSubmit').click();
        assert.equal(messages[0].suggested, originalCode);
        elements.get('btnCancel').click();
        assert.equal(messages[1].type, 'cancel');
    }
});

test('subfolder workspaces exclude storage from tracked, untracked, branch, and linked-worktree diffs', async () => {
    const repository = temporaryDirectory();
    const workspace = path.join(repository, 'packages/app');
    fs.mkdirSync(workspace, { recursive: true });
    installVscodeMock(workspace);
    const git = (...args) => execFileSync('git', args, { cwd: repository, encoding: 'utf8', stdio: 'pipe' });
    git('init', '-b', 'main');
    git('-c', 'user.name=Review Test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-m', 'initial');
    const { GitService } = built('git/gitService');
    const { LocalPrManager } = built('services/localPrManager');
    const service = new GitService({ subscriptions: [] });
    await service.initializeLocalWorktreeRoot();
    const manager = new LocalPrManager(service, workspace);
    const review = await manager.createUncommittedReview('main');
    const plan = await service.prepareDiffPlan(review);
    assert.deepEqual(await service.getChangedFiles(plan), []);
    fs.writeFileSync(path.join(workspace, 'user.ts'), 'user code\n');
    fs.mkdirSync(path.join(workspace, '.vscode/offline-reviews-user'));
    fs.writeFileSync(path.join(workspace, '.vscode/offline-reviews-user/user.json'), '{}');
    git('add', '.');
    assert.deepEqual((await service.getChangedFiles(plan)).map(f => f.filePath).sort(), [
        'packages/app/.vscode/offline-reviews-user/user.json', 'packages/app/user.ts',
    ]);
    git('branch', 'base');
    git('-c', 'user.name=Review Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'changes');
    const branchReview = await manager.createBranchReview('base', 'main', false);
    const branchPlan = await service.prepareDiffPlan(branchReview);
    assert.deepEqual((await service.getChangedFiles(branchPlan)).map(f => f.filePath).sort(), [
        'packages/app/.vscode/offline-reviews-user/user.json', 'packages/app/user.ts',
    ]);
    const linked = temporaryDirectory();
    git('worktree', 'add', '-b', 'linked', linked, 'main');
    await service.selectWorktree(linked);
    const linkedPlan = await service.prepareDiffPlan(branchReview);
    assert.deepEqual((await service.getChangedFiles(linkedPlan)).map(f => f.filePath).sort(), [
        'packages/app/.vscode/offline-reviews-user/user.json', 'packages/app/user.ts',
    ]);
});
