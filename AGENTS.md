## Reporting style

- When reporting information to me, be extremely concise. Sacrifice grammar for the sake of concision.

## Simplify before you add

- Before writing new code, read the code it will touch and ask whether the change
  fits an existing path. Prefer modifying/extending an existing flow over adding a
  parallel one. If the existing shape fights the change, refactor it first, then
  implement: two small steps, not one complicated one.
- Do not introduce an interface, adapter, wrapper, or config toggle for a single
  implementation or a single call site. Add the seam when the second implementation
  actually arrives.
- When new code replaces old behavior, delete the old path in the SAME change,
  including its config keys, dependencies, CI steps, dashboard panels, test
  fixtures, and docs. If the old path must survive temporarily (migration,
  dark launch), say so explicitly in the PR/summary and leave a dated removal note
  in the code so it can't silently become permanent.
- After your change, sweep what it orphaned: unused methods/constants/overloads,
  imports, properties nobody reads, test helpers with no callers. Delete them now;
  they are cheapest to remove while the context is loaded.
- Keep UNRELATED cleanup out of the diff. If you notice pre-existing cruft outside
  your change's blast radius, list it in your summary instead of fixing it inline.
- If you need a paragraph to justify a workaround, the code is wrong. Fix the code.

Default to using Bun instead of Node.js.

- `bun <file>` not `node` or `ts-node`
- `bun test` not `jest` or `vitest`
- `bun install` not `npm install` or `yarn`
- `bun run <script>` not `npm run`
- `bunx` not `npx`
- Bun auto-loads `.env` — don't use dotenv
- `Bun.serve()` for servers — not `express`
- `bun:sqlite`, `Bun.redis`, `Bun.sql` — not `better-sqlite3`, `ioredis`, `pg`
- `Bun.file` over `node:fs` readFile/writeFile
- `Bun.$\`cmd\``instead of`execa`

## Validation

After making all changes, always ask to run:

- `bun run format`
- `bun run lint`
- `bun run typecheck`
- `bun test` (targeted or full)
- `bun run build` if the change affects compilation

Report any failures — do not claim work is validated if these fail.

## Real Jenkins validation

Every implementation that changes Jenkins-facing behavior must add or update a
synthetic scenario in `tests/integration/jenkins.test.ts` and, when fixture
configuration is needed, `tests/integration/jenkins/init.groovy`.

- Run `bun run test:integration:jenkins`; it must build and exercise
  `dist/jenkins-cli` against the disposable `jenkins/jenkins:lts-jdk21`
  controller. Unit tests or a successful compile are not substitutes.
- Use only synthetic disposable-controller jobs and credentials. Never target a
  production Jenkins controller.
- Keep `test:integration:jenkins` in both pull-request and post-merge GitHub
  Actions workflows so the same real-controller scenario runs in CI.
- Report the local integration result and the exact GitHub Actions run when
  changes are published.

## Test isolation (Bun-specific)

Bun runs all test files in the **same process**. Mocks and spies are global.

**`mock.module` mutates the shared module object in place. `mock.restore()` does not revert the mutation.**

- Never call `mock.restore()` in `afterEach` — it is global and destroys spies and module mocks from every other running test file.
- Use `afterAll` if cleanup is needed at all.
- If a module under test may be contaminated by another file's `mock.module`, import it fresh per test: `import(\`../src/foo?t=${crypto.randomUUID()}\`)`.

**`spyOn` on globals is global.**

- Recreate spies in `beforeEach`, not at module level. Call `mockRestore()` in `afterEach`.

**Live namespace references become mocks after `mock.module` runs.**

- Capture real functions with `.bind()` before calling `mock.module`, e.g. `const realRm = realFsPromises.rm.bind(realFsPromises)`.

**`spyOn` on native streams (`process.stderr`, `process.stdout`) fails on Linux.**

- Make functions accept an optional write callback instead of spying on the stream directly.
