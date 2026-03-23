---
name: ESLint unused params rule for stub files
description: Configure @typescript-eslint/no-unused-vars to ignore underscore-prefixed parameters in stub implementations
type: feedback
---

Configure `@typescript-eslint/no-unused-vars` with `argsIgnorePattern: '^_'` so that stub implementations using `_param` naming convention (e.g., `_url`, `_password`) do not trigger lint errors.

**Why:** The codebase uses underscore-prefixed parameter names as the TypeScript convention for intentionally unused parameters in stub implementations. Without this rule override, `@typescript-eslint` flags them as errors even though they are semantically intentional and the naming is a well-understood signal.

**How to apply:** Always include this rule in `.eslintrc.cjs` when setting up new TypeScript projects with stub files. Apply to any project where stub/placeholder implementations are a first-class pattern.
