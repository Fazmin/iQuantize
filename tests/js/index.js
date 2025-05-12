// Entry point so `node --test tests/js/` works on Node 22+/24: the test runner treats the
// directory argument as a module path and resolves it to this index.js. Add new test files here.
// (Equivalent explicit form: node --test "tests/js/*.test.mjs")
import "./kb-schema.test.mjs";
import "./suites.test.mjs";
import "./info-coverage.test.mjs";
import "./help-schema.test.mjs";
