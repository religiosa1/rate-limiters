import z from "zod";
import d from "ts-dedent";
import { Script, TimeUnit, Transaction, type GlideClient } from "@valkey/valkey-glide";
import type { IRateLimiter } from "./IRateLimiter";

const tokenBucketLimiterOptsSchema = z.object({
	/** Maximum amount of request for a client in the bucket  */
	limit: z.number().int().positive(),
	/** Refill interval of token bucket in milliseconds */
	refillInterval: z.number().positive().int(),
	/** Amount of tokens to be refilled on interval */
	refillRate: z.number().positive(),
	/** Valkey keys prefix */
	keyPrefix: z.string(),
});

type TokenBucketLimiterOpts = z.infer<typeof tokenBucketLimiterOptsSchema>;

/** Token bucket limiter.
 *
 * For each client creates two keys in valkey:
 *   - tokenbucket:nTokens:${clientId} __float__ value of tokens left for the client
 *   - tokenbucket:updatedAt:${clientId} time of last nTokens update
 *
 * Each of the values have expiration datetime, which set to maximum time required
 * for a bucket to fully refill (it doesn't account for the current bucket value).
 * Refill is calculated and stored during the applyLimit call.
 *
 * This version of class calculates limit in js runtime, performing multiple
 * requests to valkey in applyLimit method andd thus is susceptible to race
 * conditions during simultaneous requests from the same client which results in
 * false negatives. Use the version of the class without NoLua suffix to address
 * the issue.
 */
export class TokenBucketLimiterNoLua implements IRateLimiter {
	static readonly defaultOpts: TokenBucketLimiterOpts = {
		limit: 5,
		refillInterval: 10_000,
		refillRate: 1,
		keyPrefix: "token_bucket_limiter",
	};

	public readonly opts: TokenBucketLimiterOpts;

	/** Time for a bucket to totally refill in ms, float */
	public get timeForCompleteRefillMs(): number {
		return (this.opts.limit / this.opts.refillRate) * this.opts.refillInterval;
	}

	constructor(protected readonly valkey: GlideClient, opts?: Partial<TokenBucketLimiterOpts>) {
		if (opts != null) {
			tokenBucketLimiterOptsSchema.partial().parse(opts);
		}
		this.opts = { ...TokenBucketLimiterNoLua.defaultOpts, ...opts };
	}

	/** Applies limiting to a client's id.
	 * @param clientId client unique id
	 * @returns true if request should be limited, false otherwise
	 */
	async applyLimit(clientId: string): Promise<boolean> {
		const currentLimit = await this.valkey.get(this.getNTokensKey(clientId));
		if (currentLimit == null) {
			await this.updateBucket(clientId, this.opts.limit - 1);
			return false;
		}
		const refilledLimit = +currentLimit + (await this.calculateRefilledTokenAmount(clientId));
		// As refilled amount is float, comparing against 1, to cut off partial refils, like 0.75
		if (refilledLimit < 1.0) {
			return true;
		}

		await this.updateBucket(clientId, refilledLimit - 1);
		return false;
	}

	/** Calculates the current token amount with calculated refill as float.
	 *
	 * Notice, it's an a calculation based on the ellapsed time since last update
	 * and bucket value captured at that time, it's not the actual stored value.
	 */
	async calculateRefilledTokenAmount(clientId: string): Promise<number> {
		const tsStr = await this.valkey.get(this.getTsKey(clientId));
		if (!tsStr) {
			return this.opts.limit;
		}
		const now = Date.now();
		const lastTs = +tsStr || 0;
		const elapsedMs = now - lastTs;

		return Math.min(this.getRefillAmountInMs(elapsedMs), this.opts.limit);
	}

	/** Returns amount of tokens that will be refilled in the duration of N ms, float */
	public getRefillAmountInMs(n: number): number {
		const refillAmount = (n / this.opts.refillInterval) * this.opts.refillRate;
		return refillAmount;
	}

	protected getNTokensKey(clientId: string): string {
		return `${this.opts.keyPrefix}:nTokens:${clientId}`;
	}

	protected getTsKey(clientId: string): string {
		return `${this.opts.keyPrefix}:updatedAt:${clientId}`;
	}

	private async updateBucket(clientId: string, nTokens: number): Promise<void> {
		const expiry = this.getExpiration();
		const clampedNToken = Math.max(Math.min(nTokens, this.opts.limit), 0);
		const transaction = new Transaction()
			.set(this.getNTokensKey(clientId), clampedNToken.toString(), { expiry })
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

/** Token bucket limiter.
 *
 * For each client creates two keys in valkey:
 *   - tokenbucket:nTokens:${clientId} __float__ value of tokens left for the client
 *   - tokenbucket:updatedAt:${clientId} time of last nTokens update
 *
 * Each of the values have expiration datetime, which set to maximum time required
 * for a bucket to fully refill (it doesn't account for the current bucket value).
 * Refill is calculated and stored during the applyLimit call.
 *
 * This version of class executes applyLimit operations as a lua script on the
 * valkey instance, to avoid potential race conditions.
 */
export class TokenBucketLimiter extends TokenBucketLimiterNoLua {
	private static readonly luaScript = new Script(d`
		local tokens_key = KEYS[1]
		local ts_key = KEYS[2]

		local limit = tonumber(ARGV[1])
		local expire_ms = tonumber(ARGV[2])
		local now_ms = tonumber(ARGV[3])
		local refill_interval = tonumber(ARGV[4])
		local refill_rate = tonumber(ARGV[5])

		${"" /* Fetch current token count and last timestamp */}
		local tokens = tonumber(redis.call('GET', tokens_key))
		local last_ts = tonumber(redis.call('GET', ts_key))

		if tokens == nil or last_ts == nil  then
			tokens = limit
			last_ts = now_ms
		else 
			local elapsed_ms = now_ms - last_ts
			if elapsed_ms > 0 then
				local refill_amount = (elapsed_ms / refill_interval) * refill_rate
				tokens = math.min(limit, tokens + refill_amount)
			end
		end

		${"" /* Attempt to consume a token */}
		local is_limited = 1
		if tokens >= 1.0 then
			tokens = tokens - 1.0
			is_limited = 0
		end

		${"" /* Update keys with new data, setting expiration */}
		redis.call('SET', tokens_key, tostring(math.max(tokens, 0)), "PX", expire_ms)
		redis.call('SET', ts_key, tostring(now_ms), "PX", expire_ms)

		return is_limited`);

	/** Applies limiting to a client's id.
	 * @param clientId client unique id
	 * @returns true if request should be limited, false otherwise
	 */
	override async applyLimit(clientId: string): Promise<boolean> {
		const expireMs = Math.ceil(this.timeForCompleteRefillMs);

		const count = await this.valkey.invokeScript(TokenBucketLimiter.luaScript, {
			keys: [this.getNTokensKey(clientId), this.getTsKey(clientId)],
			args: [this.opts.limit, expireMs, Date.now(), this.opts.refillInterval, this.opts.refillRate].map(String),
		});

		// Valkey EVAL returns 0 for false, 1 for true from Lua script
		return count === 1;
	}
}
