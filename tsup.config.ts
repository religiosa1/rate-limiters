import { defineConfig } from "tsup";

export default defineConfig({
	entry: ["index.ts"],
	format: ["esm"],
	splitting: false,
	clean: true,
});
