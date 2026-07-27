import * as os from 'os';

export type UserInfoLookup = () => { readonly username: string };

/** Resolves one stable mutation author without repeating synchronous OS account lookups. */
export class AuthorIdentity {
    private cached: string | undefined;

    constructor(
        private readonly environment: NodeJS.ProcessEnv = process.env,
        private readonly userInfo: UserInfoLookup = () => os.userInfo()
    ) {}

    get(): string {
        if (this.cached !== undefined) {
            return this.cached;
        }
        const environmentAuthor = nonempty(this.environment.USER)
            ?? nonempty(this.environment.USERNAME);
        this.cached = environmentAuthor ?? this.userInfo().username;
        return this.cached;
    }
}

function nonempty(value: string | undefined): string | undefined {
    const trimmed = value?.trim();
    return trimmed ? trimmed : undefined;
}
