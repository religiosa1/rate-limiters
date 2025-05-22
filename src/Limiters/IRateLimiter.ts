export interface IRateLimiter {
	/**
	 * Applies limiting to a client's hit
	 * @param clientId client unique id, which is determined if hit is limited
	 * @returns true if hit should be limited, false otherwise
	 */
	applyLimit(clientId: string): Promise<boolean>;

	/** Get the amount of hits a client perform right now.
	 *
	 * Calls to this method doesn't affect the allowance.
	 */
	getAvailableHits(clientId: string): Promise<number>;
}
