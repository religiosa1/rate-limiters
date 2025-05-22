import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { FixedWindowLimiter } from "./Limiters/FixedWindowLimiter";
import { client } from "./ValkeyClient";
import { TokenBucketLimiter } from "./Limiters/TokenBucketLimiter";
import { SlidingWindowLimiter } from "./Limiters/SlidingWindowLimiter";
import { createMiddleware } from "hono/factory";
import type { IRateLimiter } from "./Limiters/IRateLimiter";
import { FloatingWindowLimiter } from "./Limiters/FloatingWindowLimiter";

const app = new Hono();

const limiterMiddleware = (limiter: IRateLimiter) =>
	createMiddleware(async (c, next) => {
		const clientId = c.req.header("X-Client-Id");
		const isLimited = await limiter.applyLimit(clientId ?? "");
		if (isLimited) {
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
