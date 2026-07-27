import { StorageService } from '../storage/storageService';

/** Debounces comment-file events without dropping dirty signals during suppression. */
export class ReviewCommentsWatcherCoordinator {
    private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();

    constructor(
        private readonly storageService: StorageService,
        private readonly refresh: (reviewId: string) => void,
        private readonly debounceMs: number = 400,
        private readonly suppressionPaddingMs: number = 50
    ) {}

    notify(reviewId: string, fsPath: string): void {
        const classification = this.storageService.classifyWatch(fsPath);
        if (classification === 'exactOwnWrite') {
            return;
        }
        // A mismatch is dirty immediately even while the short own-write window
        // is active, so transition preparation cannot consume external bytes.
        this.storageService.markExternalChange(reviewId);
        const delay = classification === 'suppressed'
            ? Math.max(
                this.suppressionPaddingMs,
                this.storageService.msUntilWatchAllowed() + this.suppressionPaddingMs
            )
            : this.debounceMs;
        this.schedule(reviewId, fsPath, delay);
    }

    dispose(): void {
        for (const timer of this.timers.values()) {
            clearTimeout(timer);
        }
        this.timers.clear();
    }

    private schedule(reviewId: string, fsPath: string, delay: number): void {
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
                this.schedule(
                    reviewId,
                    fsPath,
                    Math.max(
                        this.suppressionPaddingMs,
                        remaining + this.suppressionPaddingMs
                    )
                );
            }
            // An exact own-write hash is fully observed; no disk reload is needed.
        }, delay));
    }
}
