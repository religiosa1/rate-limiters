export interface IRateLimiter {
	/**
	 * Applies limiting to a client's request
	 * @param clientId client unique id, which is determined if request is limited
	 * @returns true if request should be limited, false otherwise
	 */
	applyLimit(clientId: string): Promise<boolean>;
}
