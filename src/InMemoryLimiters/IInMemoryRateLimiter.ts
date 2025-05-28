import z from "zod";

export interface IInMemoryRateLimiter {
	/** In-memory limiter options. */
	opts: Readonly<InMemoryRateLimiterOpts>;

	/** Registers a hit from a client
	 * @param clientId client unique id, which is determined if hit is limited
	 * @returns Amount of available hits remaining for the client as integer.
	 * negative value means the client should be limitted.
	 */
	registerHit(clientId: string): number;

	/** Get the amount of hits a client perform right now.
	 *
	 * Calls to this method doesn't affect the allowance.
	 */
	getAvailableHits(clientId: string): number;

	/** Remove expired windows.
	 *
	 * This action is performed automatically on calls to `registerHit` ot
	 * `getAvailableHits`. You can call it manually, if you want to trigger
	 * this mechanism manually.
	 */
	checkExpiration(): void;

	/** Remove currently stored hit information */
	clear(): void;
}

export const inMemoryRateLimiterOptsSchema = z.object({
	/** Window size in ms */
	windowSizeMs: z.number().int().positive(),
	/** First window start, e.g. start of the day */
	startDate: z.date(),
	/** Maximum amount of hits in the window */
	limit: z.number().int().positive(),
	/** Valkey keys prefix */
});

export type InMemoryRateLimiterOpts = z.infer<typeof inMemoryRateLimiterOptsSchema>;

export const inMemoryRateLimiterOptsDefaults: InMemoryRateLimiterOpts = {
	windowSizeMs: 60_000,
	limit: 20,
	startDate: new Date(0),
};
