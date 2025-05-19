import { TimeUnit, Transaction, type GlideClient } from "@valkey/valkey-glide";
import type { IRateLimiter } from "./IRateLimiter";
import z from "zod";

const tokenBucketLimiterOptsSchema = z.object({
	/** Maximum amount of request for a client in the bucket  */
	limit: z.number().int().positive(),
	/** Refill interval of token bucket in milliseconds */
	refillInterval: z.number().positive().int(),
	/** Amount of tokens to be refilled on interval */
	refillRate: z.number().positive(),
});

type TokenBucketLimiterOpts = z.infer<typeof tokenBucketLimiterOptsSchema>;

export class TokenBucketLimiter implements IRateLimiter {
	static readonly defaultOpts: TokenBucketLimiterOpts = {
		limit: 6,
		refillInterval: 3_000,
		refillRate: 1,
	};

	public readonly opts: TokenBucketLimiterOpts;

	/** Time for a bucket to totally refill in ms, real */
	public get timeForCompleteRefillMs(): number {
		return (this.opts.limit / this.opts.refillRate) * this.opts.refillInterval;
	}

	constructor(private readonly valkey: GlideClient, opts?: Partial<TokenBucketLimiterOpts>) {
		if (opts != null) {
			tokenBucketLimiterOptsSchema.partial().parse(opts);
		}
		this.opts = { ...TokenBucketLimiter.defaultOpts, ...opts };
	}

	/**
	 * Applies limiting to a client's request
	 * @param clientId client unique id, which is determined if request is limited
	 * @returns true if request should be limited, false otherwise
	 */
	async applyLimit(clientId: string): Promise<boolean> {
		const currentLimit = await this.valkey.get(this.getNTokensKey(clientId));
		if (currentLimit == null) {
			await this.insertDefaultValue(clientId);
			return false;
		}
		const refilledLimit = +currentLimit + (await this.getTokenAmount(clientId));
		// As refilled amount is float, comparing against 1, to cut off partial refils, like 0.75
		if (refilledLimit < 1.0) {
			return true;
		}

		await this.updateBucket(clientId, refilledLimit - 1);
		return false;
	}

	/** Get the current token amount with calculated refill as real. */
	async getTokenAmount(clientId: string): Promise<number> {
		const tsStr = await this.valkey.get(this.getTsKey(clientId));
		if (!tsStr) {
			return this.opts.limit;
		}
		const now = Date.now();
		const lastTs = +tsStr || 0;
		const elapsedMs = now - lastTs;

		return this.getRefillAmountInMs(elapsedMs);
	}

	/** Returns amount of tokens that will be refilled in the duration of N ms, real */
	public getRefillAmountInMs(n: number): number {
		return (n / this.opts.refillInterval) * this.opts.refillRate;
	}

	private getNTokensKey(clientId: string): string {
		return `tokenbucket:nTokens:${clientId}`;
	}

	private getTsKey(clientId: string): string {
		return `tokenbucket:last-call-ts:${clientId}`;
	}

	private async updateBucket(clientId: string, nTokens: number): Promise<void> {
		const expiry = this.getExpiration();
		const clampedNToken = Math.max(Math.min(nTokens, this.opts.limit), 0);
		const transaction = new Transaction()
			.set(this.getNTokensKey(clientId), clampedNToken.toString(), { expiry })
			.set(this.getTsKey(clientId), Date.now().toString(), { expiry });
		await this.valkey.exec(transaction);
	}

	private async insertDefaultValue(clientId: string): Promise<void> {
		const expiry = this.getExpiration();
		const transaction = new Transaction()
			.set(this.getNTokensKey(clientId), (this.opts.limit - 1).toString(), { expiry })
			.set(this.getTsKey(clientId), Date.now().toString(), { expiry });
		await this.valkey.exec(transaction);
	}

	private getExpiration() {
		return {
			type: TimeUnit.Milliseconds,
			count: Math.ceil(this.timeForCompleteRefillMs),
		};
	}
}
