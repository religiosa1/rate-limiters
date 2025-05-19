import { GlideClient } from "@valkey/valkey-glide";

const addresses = [
  {
      host: process.env.VALKEY_HOST || "localhost",
      port: +process.env.VALKEY_PORT! || 6379,
  },
];

// Check `GlideClientConfiguration/GlideClusterClientConfiguration` for additional options.
export const client = await GlideClient.createClient({
  addresses: addresses,
  // if the server uses TLS, you'll need to enable it. Otherwise, the connection attempt will time out silently.
  // useTLS: true,
  clientName: "test_standalone_client",
});