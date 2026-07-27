import { StorageService } from '../storage/storageService';
/** Debounces comment-file events without dropping dirty signals during suppression. */
export declare class ReviewCommentsWatcherCoordinator {
    private readonly storageService;
    private readonly refresh;
    private readonly debounceMs;
    private readonly suppressionPaddingMs;
    private readonly timers;
    constructor(storageService: StorageService, refresh: (reviewId: string) => void, debounceMs?: number, suppressionPaddingMs?: number);
    notify(reviewId: string, fsPath: string): void;
    dispose(): void;
    private schedule;
}
