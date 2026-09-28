// The kit's tests. `scripts/test-helper.sh` compiles sources/kit with this
// directory and runs the result; the package's vitest suite runs that script
// on a Mac (test/helper-kit.test.ts).

import Foundation

scopeTests()
lifecycleTests()
wireTests()
deliveryTests()

print("\(checks) checks, \(failures) failed")
exit(failures == 0 ? 0 : 1)
