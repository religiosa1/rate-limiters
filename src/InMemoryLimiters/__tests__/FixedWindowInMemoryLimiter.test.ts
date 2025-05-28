import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { FixedWindowInMemoryLimiter } from "../FixedWindowInMemoryLimiter";

describe("FixedWindowInMemoryLimiter", () => {
	beforeAll(() => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
	});

	afterAll(() => {
		vi.useRealTimers();
	});

	it("limits the hits to the amount in fixed period", () => {
		const clientId = crypto.randomUUID();
		const fwl = new FixedWindowInMemoryLimiter({ limit: 3, windowSizeMs: 60_000 });

		expect(fwl.registerHit(clientId)).toBe(2);
		expect(fwl.registerHit(clientId)).toBe(1);
		expect(fwl.registerHit(clientId)).toBe(0);
		expect(fwl.registerHit(clientId)).toBe(-1);
	});

	it("treats hits from separate clients separately", () => {
		const clientId1 = crypto.randomUUID();
		const clientId2 = crypto.randomUUID();
		const fwl = new FixedWindowInMemoryLimiter({ limit: 3, windowSizeMs: 60_000 });

		expect(fwl.registerHit(clientId1)).toBe(2);
		expect(fwl.registerHit(clientId1)).toBe(1);
		expect(fwl.registerHit(clientId2)).toBe(2);
	});

	it("drops limits after predefined amount of time has passed", () => {
		const clientId = crypto.randomUUID();
		const fwl = new FixedWindowInMemoryLimiter({ limit: 3, windowSizeMs: 60_000 });

		expect(fwl.registerHit(clientId)).toBe(2);
		expect(fwl.registerHit(clientId)).toBe(1);
		vi.advanceTimersByTime(60_000);
		expect(fwl.registerHit(clientId)).toBe(2);
	});

	it("allows to get the current available hits amount", () => {
		const clientId = crypto.randomUUID();
		const fwl = new FixedWindowInMemoryLimiter({ limit: 3, windowSizeMs: 60_000 });

		expect(fwl.getAvailableHits(clientId)).toBe(3);
		expect(fwl.registerHit(clientId)).toBe(2);
		expect(fwl.getAvailableHits(clientId)).toBe(2);
		expect(fwl.getAvailableHits(clientId)).toBe(2);
		expect(fwl.registerHit(clientId)).toBe(1);
	});
});
