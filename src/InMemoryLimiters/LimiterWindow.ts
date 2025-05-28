export class RateLimiterWindow {
	clientHitCounter = new Map<string, number>();
	endTs: number;

	constructor(public startTs: number, public duration: number) {
		this.endTs = startTs + duration;
	}

	isExpiredAt(ts: number): boolean {
		const isInRange = this.startTs <= ts && ts < this.endTs;
		return !isInRange;
	}
}
