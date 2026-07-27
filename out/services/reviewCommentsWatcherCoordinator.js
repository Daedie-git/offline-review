"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ReviewCommentsWatcherCoordinator = void 0;
/** Debounces comment-file events without dropping dirty signals during suppression. */
class ReviewCommentsWatcherCoordinator {
    constructor(storageService, refresh, debounceMs = 400, suppressionPaddingMs = 50) {
        this.storageService = storageService;
        this.refresh = refresh;
        this.debounceMs = debounceMs;
        this.suppressionPaddingMs = suppressionPaddingMs;
        this.timers = new Map();
    }
    notify(reviewId, fsPath) {
        const classification = this.storageService.classifyWatch(fsPath);
        if (classification === 'exactOwnWrite') {
            return;
        }
        // A mismatch is dirty immediately even while the short own-write window
        // is active, so transition preparation cannot consume external bytes.
        this.storageService.markExternalChange(reviewId);
        const delay = classification === 'suppressed'
            ? Math.max(this.suppressionPaddingMs, this.storageService.msUntilWatchAllowed() + this.suppressionPaddingMs)
            : this.debounceMs;
        this.schedule(reviewId, fsPath, delay);
    }
    dispose() {
        for (const timer of this.timers.values()) {
            clearTimeout(timer);
        }
        this.timers.clear();
    }
    schedule(reviewId, fsPath, delay) {
        const previous = this.timers.get(fsPath);
        if (previous) {
            clearTimeout(previous);
        }
        this.timers.set(fsPath, setTimeout(() => {
            this.timers.delete(fsPath);
            const classification = this.storageService.classifyWatch(fsPath);
            if (classification === 'external') {
                this.refresh(reviewId);
                return;
            }
            if (classification === 'suppressed') {
                const remaining = this.storageService.msUntilWatchAllowed();
                this.schedule(reviewId, fsPath, Math.max(this.suppressionPaddingMs, remaining + this.suppressionPaddingMs));
            }
            // An exact own-write hash is fully observed; no disk reload is needed.
        }, delay));
    }
}
exports.ReviewCommentsWatcherCoordinator = ReviewCommentsWatcherCoordinator;
//# sourceMappingURL=reviewCommentsWatcherCoordinator.js.map