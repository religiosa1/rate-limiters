import z from "zod";
import d from "ts-dedent";
import { Script, TimeUnit, Transaction, type GlideClient } from "@valkey/valkey-glide";
import type { IRateLimiter } from "./IRateLimiter";

const tokenBucketLimiterOptsSchema = z.object({
	/** Maximum amount of hits for a client in the bucket  */
	limit: z.number().int().positive(),
	/** Refill interval of token bucket in milliseconds */
	refillIntervalMs: z.number().positive().int(),
	/** Amount of tokens to be refilled on interval */
	refillRate: z.number().positive(),
	/** Valkey keys prefix */
	keyPrefix: z.string(),
});

type TokenBucketLimiterOpts = z.infer<typeof tokenBucketLimiterOptsSchema>;

/** Token bucket limiter -- js runtime version.
 *
 * For each client creates two keys in valkey:
 *   - tokenbucket:nTokens:${clientId} __float__ value of tokens left for the client
 *   - tokenbucket:updatedAt:${clientId} time of last nTokens update
 *
 * Each of the values have expiration datetime, which set to maximum time required
 * for a bucket to fully refill (it doesn't account for the current bucket value).
 * Refill is calculated and stored during the registerHit call.
 *
 * This version of class calculates limit in js runtime, performing multiple
 * hits to valkey in registerHit method andd thus is susceptible to race
 * conditions during simultaneous hits from the same client which results in
 * false negatives. Use the version of the class without NoLua suffix to address
 * the issue.
 */
export class TokenBucketLimiterNoLua implements IRateLimiter {
	static readonly defaultOpts: TokenBucketLimiterOpts = {
		limit: 20,
		refillIntervalMs: 3_000,
		refillRate: 1,
		keyPrefix: "token_bucket_limiter",
	};

	public readonly opts: TokenBucketLimiterOpts;

	/** Time for a bucket to totally refill in ms, float */
	public get timeForCompleteRefillMs(): number {
		return (this.opts.limit / this.opts.refillRate) * this.opts.refillIntervalMs;
	}

	constructor(protected readonly valkey: GlideClient, opts?: Partial<TokenBucketLimiterOpts>) {
		if (opts != null) {
			tokenBucketLimiterOptsSchema.partial().parse(opts);
		}
		this.opts = { ...TokenBucketLimiterNoLua.defaultOpts, ...opts };
	}

	async registerHit(clientId: string): Promise<number> {
		const nowTs = Date.now();
		const currentLimit = (await this.valkey.get(this.getNTokensKey(clientId))) ?? this.opts.limit;
		const tokensCount = +currentLimit + (await this.calculateRefilledTokenAmountAtTime(clientId, nowTs));

		// Consuming a token, if available, otherwise just updating the bucket with new expiry
		const valuetoUpdate = tokensCount >= 1.0 ? tokensCount - 1 : tokensCount;
		await this.updateBucket(clientId, valuetoUpdate, nowTs);
		// return value is always "consumed", to denote limited requests
		return Math.floor(tokensCount - 1);
	}

	async getAvailableHits(clientId: string): Promise<number> {
		const tokensLeft = +((await this.valkey.get(this.getNTokensKey(clientId))) ?? this.opts.limit);
		const refil = await this.calculateRefilledTokenAmountAtTime(clientId, Date.now());
		return tokensLeft + refil;
	}

	/** Calculates the current token amount with calculated refill as float.
	 *
	 * Notice, it's an a calculation based on the ellapsed time since last update
	 * and bucket value captured at that time, it's not the actual stored value.
	 */
	private async calculateRefilledTokenAmountAtTime(clientId: string, ts: number): Promise<number> {
		const tsStr = await this.valkey.get(this.getTsKey(clientId));
		if (!tsStr) {
			return 0;
		}
		const lastTs = +tsStr || 0;
		const elapsedMs = ts - lastTs;

		return Math.min(this.getRefillAmountInMs(elapsedMs), this.opts.limit);
	}

	/** Returns amount of tokens that will be refilled in the duration of N ms, float */
	public getRefillAmountInMs(n: number): number {
		const refillAmount = (n / this.opts.refillIntervalMs) * this.opts.refillRate;
		return refillAmount;
	}

	protected getNTokensKey(clientId: string): string {
		return `${this.opts.keyPrefix}:nTokens:${clientId}`;
	}

	protected getTsKey(clientId: string): string {
		return `${this.opts.keyPrefix}:updatedAt:${clientId}`;
	}

	private async updateBucket(clientId: string, nTokens: number, nowTs: number): Promise<void> {
		const expiry = this.getExpiration();
		const clampedNToken = Math.max(Math.min(nTokens, this.opts.limit), 0);
		const transaction = new Transaction()
			.set(this.getNTokensKey(clientId), clampedNToken.toString(), { expiry })
			.set(this.getTsKey(clientId), nowTs.toString(), { expiry });
		await this.valkey.exec(transaction);
	}

	private getExpiration() {
		return {
			type: TimeUnit.Milliseconds,
			count: Math.ceil(this.timeForCompleteRefillMs),
		};
	}
}

/** Token bucket limite -- lua on valkey version.
 *
 * For each client creates two keys in valkey:
 *   - tokenbucket:nTokens:${clientId} __float__ value of tokens left for the client
 *   - tokenbucket:updatedAt:${clientId} time of last nTokens update
 *
 * Each of the values have expiration datetime, which set to maximum time required
 * for a bucket to fully refill (it doesn't account for the current bucket value).
 * Refill is calculated and stored during the registerHit call.
 *
 * This version of class executes registerHit operations as a lua script on the
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
		local tokens_count = tonumber(redis.call('GET', tokens_key))
		local last_ts = tonumber(redis.call('GET', ts_key))

		if tokens_count == nil or last_ts == nil  then
			tokens_count = limit
			last_ts = now_ms
		else 
			local elapsed_ms = now_ms - last_ts
			if elapsed_ms > 0 then
				local refill_amount = (elapsed_ms / refill_interval) * refill_rate
				tokens_count = math.min(limit, tokens_count + refill_amount)
			end
		end

		${"" /* Attempt to consume a token */}
		local update_value = 0.0
		if tokens_count >= 1.0 then
			update_value = (tokens_count - 1.0)
		else 
			update_value = tokens_count
		end

		${"" /* Update keys with new data, setting expiration */}
		redis.call('SET', tokens_key, tostring(math.max(update_value, 0)), "PX", expire_ms)
		redis.call('SET', ts_key, tostring(now_ms), "PX", expire_ms)

		${"" /* Passing float as string, otherwise precission is getting lost */}
		return tostring(tokens_count - 1.0)`);

	override async registerHit(clientId: string): Promise<number> {
		const expireMs = Math.ceil(this.timeForCompleteRefillMs);

		let result = await this.valkey.invokeScript(TokenBucketLimiter.luaScript, {
			keys: [this.getNTokensKey(clientId), this.getTsKey(clientId)],
			args: [this.opts.limit, expireMs, Date.now(), this.opts.refillIntervalMs, this.opts.refillRate].map(String),
		});
		result = Number(result);
		return Math.floor(result);
	}
}
