// ESLint 9 flat config: TypeScript + React Hooks for the Vite/React frontend.
// The Rust core is linted by clippy, not ESLint.
import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";

export default tseslint.config(
  {
    ignores: ["dist/**", "dist-ssr/**", "coverage/**", "node_modules/**", "src-tauri/**"],
  },
  {
    files: ["**/*.{ts,tsx}"],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    languageOptions: {
      ecmaVersion: 2021,
      sourceType: "module",
      globals: { ...globals.browser },
    },
    plugins: { "react-hooks": reactHooks },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      // Encode the Zustand stable-selector gotcha (see CONTRIBUTING.md): an
      // object/array literal returned from a `useStore` selector is a fresh
      // reference every render and causes re-render storms. Prefer atomic
      // single-value selectors or `useShallow()`.
      "no-restricted-syntax": [
        "warn",
        {
          selector:
            "CallExpression[callee.name=/^use.*Store$/] > ArrowFunctionExpression > ObjectExpression",
          message:
            "Zustand selector returns a new object every render — use atomic selectors or useShallow() for a stable reference.",
        },
        {
          selector:
            "CallExpression[callee.name=/^use.*Store$/] > ArrowFunctionExpression > ArrayExpression",
          message:
            "Zustand selector returns a new array every render — use atomic selectors or useShallow() for a stable reference.",
        },
      ],
    },
  },
);
