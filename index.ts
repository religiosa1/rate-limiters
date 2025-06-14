import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { createMiddleware } from "hono/factory";
import { client } from "./src/ValkeyClient";

import { FixedWindowLimiter } from "./src/Limiters/FixedWindowLimiter";
import { TokenBucketLimiter } from "./src/Limiters/TokenBucketLimiter";
import { SlidingWindowLimiter } from "./src/Limiters/SlidingWindowLimiter";
import type { IRateLimiter } from "./src/Limiters/IRateLimiter";
import { FloatingWindowLimiter } from "./src/Limiters/FloatingWindowLimiter";

const app = new Hono();

const limiterMiddleware = (limiter: IRateLimiter) =>
	createMiddleware(async (c, next) => {
		const clientId = c.req.header("X-Client-Id");
		if (limiter instanceof FixedWindowLimiter) {
			const resetTimestamp = await limiter.getCurrentWindowStopTsMs();
			c.res.headers.set("x-ratelimit-reset", new Date(resetTimestamp).toISOString());
		}
		const hitsRemaining = await limiter.registerHit(clientId ?? "");
		c.res.headers.set("x-ratelimit-remaining", hitsRemaining.toString());
		c.res.headers.set("x-ratelimit-limit", limiter.opts.limit.toString());
		if (hitsRemaining < 0) {
			throw new HTTPException(429);
		}
		await next();
	});

const limit = 5;
const windowSizeMs = 10_000;

const commonLimiterOpts = { limit, windowSizeMs };

app.use("/fixed-window", limiterMiddleware(new FixedWindowLimiter(client, commonLimiterOpts)));
app.use("/sliding-window", limiterMiddleware(new SlidingWindowLimiter(client, commonLimiterOpts)));
app.use("/floating-window", limiterMiddleware(new FloatingWindowLimiter(client, commonLimiterOpts)));
app.use("/token-bucket", limiterMiddleware(new TokenBucketLimiter(client, { limit, refillIntervalMs: 2_000 })));

app.get("*", (c) => {
	return c.text("Hello Hono!");
});

serve(
	{
		fetch: app.fetch,
		port: 3000,
	},
	(info) => {
		console.log(`Server is running on http://localhost:${info.port}`);
	}
);
