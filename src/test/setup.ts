// Vitest + Testing Library setup. Registers jest-dom matchers
// (`toBeInTheDocument`, `toHaveTextContent`, …) on Vitest's `expect` and
// unmounts rendered trees between tests.
import "@testing-library/jest-dom/vitest";
import { afterEach } from "vitest";
import { cleanup, configure } from "@testing-library/react";

// CI hardening: Testing Library's default async-utils timeout (`findBy*` /
// `waitFor`) is 1000ms. The heavily-loaded `windows-latest` GitHub runner can
// blow past that while a mocked-promise resolution + React `act()` flush waits
// its turn under file-parallel load — surfacing as spurious "Unable to find …"
// timeouts on Windows while Linux/local stay green. Give async queries generous
// headroom so they reflect render *correctness*, not runner scheduling latency.
// This only extends how long a query waits for the DOM to settle; a genuinely
// absent node still fails the assertion (just a few seconds later, not at 1s).
configure({ asyncUtilTimeout: 5000 });

afterEach(() => {
  cleanup();
});
