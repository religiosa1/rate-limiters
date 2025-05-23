export interface IRateLimiter {
	/** Limiter options.
	 *
	 * May contain additional options, but these fields are common to all limiters */
	opts: Readonly<{
		/** The maximum amount of hits in the time window */
		limit: number;
		/** valkey keys prefix */
		keyPrefix: string;
	}>;

	/** Registers a hit from a client
	 * @param clientId client unique id, which is determined if hit is limited
	 * @returns Amount of available hits remaining for the client as integer.
	 * negative value means the client should be limitted.
	 */
	registerHit(clientId: string): Promise<number>;

	/** Get the amount of hits a client perform right now.
	 *
	 * Calls to this method doesn't affect the allowance.
	 */
	getAvailableHits(clientId: string): Promise<number>;
}
