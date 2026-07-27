export declare function withFileLock<T>(lockPath: string, action: () => T, verifyDirectory?: () => void): T;
