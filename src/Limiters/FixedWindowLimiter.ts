import z from "zod";
import { Script, type GlideClient } from "@valkey/valkey-glide";
import type { IRateLimiter } from "./IRateLimiter";

const fixedWindowLimiterOptsSchema = z.object({
	/** Fixed Window size in ms */
	duration: z.number().int().positive(),
	/** First window start, e.g. start of the day */
	startDate: z.date(),
	/** Maximum amount of requests in the window */
	limit: z.number().int().positive(),
	keyPrefix: z.string(),
});
type FixedWindowLimiterOpts = z.infer<typeof fixedWindowLimiterOptsSchema>;

/** Fixed window limiter.
 *
 * Stores the amount of requests per window in a single key, which contains
 * window start timestamp and expires, when the window expires. applyLimit
 * calls increase the value of this counter, and if it's greater than or equal
 * to the limit option, the request will be considered limited.
 */
export class FixedWindowLimiter implements IRateLimiter {
	static readonly defaultOpts: FixedWindowLimiterOpts = {
		duration: 60_000,
		limit: 1,
		startDate: new Date(0),
		keyPrefix: "fixed_window_limiter:",
	};

	private static readonly luaScript = new Script(`
    local key = KEYS[1]
    local limit = tonumber(ARGV[1])
    local expire_at_seconds = tonumber(ARGV[2])

    local current_count = redis.call('INCR', key)

    if current_count == 1 then
        -- This is the first request in the window, set expiration
        redis.call('EXPIREAT', key, expire_at_seconds)
    end

    if current_count > limit then
        return true -- Rate limited
    else
        return false -- Allowed
    end
  `);

	public readonly opts: FixedWindowLimiterOpts;

	constructor(private readonly valkey: GlideClient, opts?: Partial<FixedWindowLimiterOpts>) {
		if (opts != null) {
			fixedWindowLimiterOptsSchema.partial().parse(opts);
		}
		this.opts = { ...FixedWindowLimiter.defaultOpts, ...opts };
	}

	/** Applies limiting to a client's id.
	 * @param clientId client unique id
	 * @returns true if request should be limited, false otherwise
	 */
	async applyLimit(clientId: string): Promise<boolean> {
		const key = this.getClientKey(clientId);
		const expireAtSeconds = Math.floor(this.getCurrentWindowStopTs() / 1000);

		const result = await this.valkey.invokeScript(FixedWindowLimiter.luaScript, {
			keys: [key],
			args: [this.opts.limit.toString(), expireAtSeconds.toString()],
		});

		// Valkey EVAL returns 0 for false, 1 for true from Lua script
		return !!result;
	}

	/** Get the amount of requests performed during the current window (<= limit) */
	async getCurrentRequestAmount(clientId: string): Promise<number | null> {
		const key = this.getClientKey(clientId);
		const str = await this.valkey.get(key);
		return str ? +str : null;
	}

	private getClientKey(clientId: string): string {
		const startTs = this.getCurrentWindowStartTs();
		return `${this.opts.keyPrefix}:${startTs}:${clientId}`;
	}

	private getCurrentWindowStartTs(): number {
		const start = this.opts.startDate.getTime();
		const duration = this.opts.duration;
		return Math.floor((Date.now() - start) / duration) * duration + start;
	}

	private getCurrentWindowStopTs(): number {
		return this.getCurrentWindowStartTs() + this.opts.duration;
	}
}
