import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test_hook.ts", "test_hooks.ts", "test_hook_rootdb.ts"],
    globals: true,
  },
});
