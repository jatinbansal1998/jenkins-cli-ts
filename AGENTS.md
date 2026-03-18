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

After changes, always run before finishing:

- `bun run format`
- `bun run lint`
- `bun run typecheck`
- `bun test` (targeted or full)
- `bun run build` if the change affects compilation

Report any failures — do not claim work is validated if these fail.

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
