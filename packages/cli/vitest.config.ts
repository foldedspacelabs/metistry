// The only reason this package has a vitest config: `test/setup.ts` must run
// for every file, not for the ones that remembered to ask. See its header.
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    setupFiles: ["./test/setup.ts"],
  },
});
