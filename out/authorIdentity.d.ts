export type UserInfoLookup = () => {
    readonly username: string;
};
/** Resolves one stable mutation author without repeating synchronous OS account lookups. */
export declare class AuthorIdentity {
    private readonly environment;
    private readonly userInfo;
    private cached;
    constructor(environment?: NodeJS.ProcessEnv, userInfo?: UserInfoLookup);
    get(): string;
}
