import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { FloatingWindowInMemoryLimiter } from "../FloatingWindowInMemoryLimiter";

describe("FloatingWindowInMemoryLimiter", () => {
	beforeAll(() => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
	});

	afterAll(() => {
		vi.useRealTimers();
	});

	it("limits the hits to the amount in fixed period", () => {
		const clientId = crypto.randomUUID();
		const fwl = new FloatingWindowInMemoryLimiter({ limit: 3, windowSizeMs: 60_000 });

		expect(fwl.registerHit(clientId)).toBe(2);
		expect(fwl.registerHit(clientId)).toBe(1);
		expect(fwl.registerHit(clientId)).toBe(0);
		expect(fwl.registerHit(clientId)).toBe(-1);
	});

	it("treats hits from separate clients separately", () => {
		const clientId1 = crypto.randomUUID();
		const clientId2 = crypto.randomUUID();
		const fwl = new FloatingWindowInMemoryLimiter({ limit: 3, windowSizeMs: 60_000 });

		expect(fwl.registerHit(clientId1)).toBe(2);
		expect(fwl.registerHit(clientId1)).toBe(1);
		expect(fwl.registerHit(clientId2)).toBe(2);
	});

	it("drops limits after predefined amount of time has passed", () => {
		const clientId = crypto.randomUUID();
		const fwl = new FloatingWindowInMemoryLimiter({ limit: 4, windowSizeMs: 60_000 });

		// Consuming half of requets
		expect(fwl.registerHit(clientId)).toBe(3);
		vi.advanceTimersByTime(500);
		expect(fwl.registerHit(clientId)).toBe(2);
		// Waiting for new window to arrive + half of the time from previous bucket to pass
		// It should mean, that we have 1 request transfered from the previous window (2 * 0.5)
		// and then additional one -- result should be 2
		vi.advanceTimersByTime(60_000 + 30_000);
		expect(fwl.registerHit(clientId)).toBe(2);
	});

	it("drops all of the requests if both current and previous bucket expire since the last call", () => {
		const clientId = crypto.randomUUID();
		const fwl = new FloatingWindowInMemoryLimiter({ limit: 4, windowSizeMs: 60_000 });

		// Consuming half of requets
		expect(fwl.registerHit(clientId)).toBe(3);
		vi.advanceTimersByTime(500);
		expect(fwl.registerHit(clientId)).toBe(2);
		vi.advanceTimersByTime(60_000 * 2);
		expect(fwl.registerHit(clientId)).toBe(3);
	});

	it("allows to get the current available hits amount", () => {
		const clientId = crypto.randomUUID();
		const fwl = new FloatingWindowInMemoryLimiter({ limit: 3, windowSizeMs: 60_000 });

		expect(fwl.getAvailableHits(clientId)).toBe(3);
		expect(fwl.registerHit(clientId)).toBe(2);
		expect(fwl.getAvailableHits(clientId)).toBe(2);
		expect(fwl.getAvailableHits(clientId)).toBe(2);
		expect(fwl.registerHit(clientId)).toBe(1);
	});
});
