# Writing TypeScript

> A guide to writing idiomatic TypeScript for this codebase.

Echoriad is a Pi extension written in TypeScript. Three toolchain facts shape most of this document. First, the code is executed by Node's type stripping: Node erases types at runtime, performs no type checking, and reads no `tsconfig.json`, so the language subset is constrained to _erasable syntax_ and the compiler is a checker we run separately, not a build step. Second, the tests run on the standard library's `node:test`, not a test framework. Third, Biome is the formatter and the linter; `npm run check` is the gate and `npm run fix` applies safe fixes.

This document normalizes the project. Where the ecosystem is split, it picks; where it picks, the pick is listed in §13 and the reasons in the section itself. Where the ecosystem has not converged, the open question goes to §14 instead of being decided by drift.

---

## 1. Runtime subset: erasable TypeScript only

Node's type stripping replaces TypeScript syntax with whitespace. Features that require _transformation_ — the compiler generating new JavaScript — are not erasable, and Node rejects them with `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`. The banned set, from the [Node.js documentation](https://nodejs.org/api/typescript.html):

- **`enum` declarations.** Enums generate a runtime object. Use a string-literal union, or an `as const` object when you need a value map (§4.5).
- **`namespace` with runtime code.** A `namespace` exporting only types parses; one containing values errors. Don't use namespaces at all (§5).
- **Parameter properties** (`constructor(private x: string)`). They generate field assignments. Assign fields explicitly.
- **Import aliases** (`import x = require('...')`). Use `import`.
- **Legacy decorators.** Decorators are an untransformed Stage 3 proposal and reach Node as a parser error.

The practical reading: TypeScript here is a _type layer on JavaScript_, not a language that compiles to JavaScript. Anything the type layer can express, write it; anything that emits runtime code, write the JavaScript yourself.

## 2. Compiler strictness

Type stripping performs no type checking, so checking is a separate gate we run with `tsc --noEmit` using `strict: true`. The baseline:

- **`strict: true`** — includes `noImplicitAny`, `strictNullChecks`, `strictFunctionTypes`, `strictBindCallApply`, `strictPropertyInitialization`, `noImplicitThis`, `useUnknownInCatchVariables`, `alwaysStrict`. This is the ecosystem floor for any new project; TypeScript's own handbook treats the flags' absence as a migration state, not a choice.
- **`target: esnext`, `module: nodenext`** — the settings Node's documentation recommends for type-stripped code. The runtime is whatever Node ships; there is no downleveling.
- **`verbatimModuleSyntax: true`** — type imports must say `import type`, matching exactly what Node requires at runtime (§5).
- **`erasableSyntaxOnly: true`** — makes the compiler enforce the §1 subset, so the §1 rules are checked, not aspirational.
- **`noEmit: true`** — nothing builds; this config exists to check.

Two stricter flags the ecosystem recommends but this project has not adopted — `exactOptionalPropertyTypes` and `noUncheckedIndexedAccess` — are tracked in §14.

`tsc` is a check gate alongside `biome check .`. Type errors fail the same way lint errors do; there is no emitted artifact to be out of sync with them.

## 3. Naming

Casing by identifier kind. The table matches the defaults of typescript-eslint's [`naming-convention`](https://typescript-eslint.io/rules/naming-convention/) rule, the [Google style guide](https://google.github.io/styleguide/tsguide.html), and the TypeScript team's own guidelines:

| Kind                                            | Style        | Examples                                       |
| ----------------------------------------------- | ------------ | ---------------------------------------------- |
| Type, class, interface, enum-like               | `PascalCase` | `ProjectConfig`, `GuestImageError`             |
| Variable, parameter, function, method, property | `camelCase`  | `parseConfigFile`, `guestImage`                |
| Module-level constant intended as immutable     | `UPPER_CASE` | `CONFIG_PATH`, `FINGERPRINT_SCHEMA_VERSION`    |
| Local constant                                  | `camelCase`  | `const selection = resolveImageSelection(...)` |

- **Initialisms keep their case throughout the identifier**: `loadSystemConfig`, `systemConfigPath`, `computeBuildId` — never `loadSystemConfigID`'s cousin `systemConfigId`, and never a leading `I` on interfaces (`ProjectConfig`, not `IProjectConfig` — the `I` prefix is explicitly ruled out by the TypeScript team's guidelines and by every modern codebase).
- **No leading underscore for "private"** — TypeScript privacy is expressed by _not exporting_ the definition (module scope), or by `#private` fields on classes. The `_` prefix is a C++ habit with no compiler meaning here.
- **Booleans read as predicates**: `isPermanent`, `hasApprovedBuild`, `canReuse`. A getter returning `boolean` doesn't take a `get` prefix.
- **Functions are verbs**, constructors are `createX` / `resolveX` / `parseX` by what the call does, not `getX` (§7).
- **No grab-bag modules.** `util`, `common`, `helpers` are ruled out; a helper lives in the module that owns the concept it helps with (§6).

## 4. Types

### 4.1 Primitives and wrappers

Use the lowercase primitive types: `string`, `number`, `boolean`, `symbol`, `object`. The boxed wrappers `String`, `Number`, `Boolean`, `Symbol`, `Object` refer to non-primitive objects and are effectively always wrong — this is the first ruling in the handbook's [Do's and Don'ts](https://www.typescriptlang.org/docs/handbook/declaration-files/do-s-and-donts.html), and it is universal.

### 4.2 `any` and `unknown`

`any` disables type checking for everything it touches — the handbook's own words — and the handbook restricts it to "migrating a JavaScript project to TypeScript." Echoriad is not migrating. The rules:

- **No explicit `any` in `src/`.** typescript-eslint's `recommended` preset bans it (`no-explicit-any`); Biome's `recommended` warns on it; this project treats it as an error in production code.
- **When a value's shape is unknown, use `unknown` and narrow.** `unknown` accepts any value but _requires narrowing before use_, which is exactly the discipline `any` discards. Every narrowing construct works on it: `typeof`, `instanceof`, user-defined type predicates, `satisfies`, `in`.
- **When a value is pass-through at a boundary**, `unknown` is still right: accept `unknown`, validate, hand the validated value on.
- **Test code may use `any` for fakes** — deliberately loose stubs are a testing idiom, and §12 scopes the lint override to `test/**`. The narrow-before-use rule still applies to any value that crosses back into production code.

Catch clauses are typed `unknown` under `strict` (via `useUnknownInCatchVariables`); narrow with `instanceof Error` or `typeof` before reading fields.

### 4.3 `interface` vs `type`

Ecosystem default: object shapes are `interface`s; everything else is a `type`. This is typescript-eslint's [`consistent-type-definitions`](https://typescript-eslint.io/rules/consistent-type-definitions/) default (`'interface'`) and the Google guide's ruling ("prefer interfaces over type literal aliases"). The split:

- **`interface`** for object shapes — config records, parameter objects, contracts implemented by more than one class.
- **`type`** for unions (`MountConfig = string | HostMountConfig | MemoryMountConfig`), intersections, mapped types, conditional types, and compositions of utility types. An interface cannot express these.

Interfaces have one capability `type` lacks — declaration merging — and one cost from the same capability: any consumer can silently merge fields into them. Treat merging as an anti-feature here. If a type's fields are closed, it stays closed by being a `type` or by nobody augmenting it; either way, don't reach for merging as a design tool.

Don't mix the two for the same shape. A shape declared `interface` stays an interface as it evolves.

### 4.4 Unions, literal types, and narrowing

Sum types are unions of literals, narrowed by control flow:

```ts
type ImageSelection =
  | { kind: "image"; origin: "env" | "project" | "system"; imageRef: string }
  | { kind: "buildConfig"; origin: "project" | "system"; configPath: string };

function originLabel(selection: ImageSelection): string {
  switch (selection.kind) {
    case "image":
      return `image ${selection.imageRef} (${selection.origin})`;
    case "buildConfig":
      return `build config ${selection.configPath} (${selection.origin})`;
  }
}
```

- **Discriminate unions with a `kind` field** (any closed tag name works; `kind` is the common one) so `switch` exhaustiveness is checked. A missing case is a compile error when the switch has no default and the function must return.
- **Narrow, don't assert.** Every cast (`as`) is a claim the compiler can't check and a bug surface when the claim goes stale. Narrow with `typeof`, `in`, `instanceof`, discriminated unions, or a user-defined predicate (`x is T`). The remaining legitimate `as` is at a _checked boundary_: you validated the shape by other means and are telling the compiler so.
- **`satisfies` over `as`** for "check this literal against a type without widening it": `const CONFIG = { ... } satisfies ProjectConfig;` keeps inference while checking conformance.
- **Non-null assertion `!` is an unchecked claim about nullability**, with the same standing as any other cast: avoid it in `src/`. After setup in test code, where the invariant was established by the harness itself, it is accepted (§12). Prefer restructuring so the value can't be null.

### 4.5 No enums — string-literal unions and `as const`

Two independent reasons converge here. The toolchain one is decisive: enums are runtime objects, so §1 bans them outright under type stripping. The stylistic one: string-literal unions are the modern idiom (typescript-eslint's strict presets actively restrict enum misuse; the handbook treats unions as the default way to model closed sets).

```ts
type ImageSource = "selector" | "buildConfig";

const IMAGE_SOURCE_LABEL: Record<ImageSource, string> = {
  selector: "image selector",
  buildConfig: "build config",
};
```

The `as const` object gives you the value map enums provided, with real keys and no generated runtime shape. When you need the union _from_ the object: `type ImageSource = keyof typeof IMAGE_SOURCE_LABEL;`

### 4.6 Nullability

- **Absence is `undefined`; optional fields use `?`.** `milk?: Whole | LowFat` — not `milk: Whole | LowFat | undefined`. The `?` marks the field as _omittable_, which `| undefined` does not; the Google guide rules for `?` explicitly. (The TypeScript team's internal guidelines prefer `undefined` over `null`; `null` appears only where a host API produces it.)
- **Don't bake nullability into aliases.** `type Config = ProjectConfig | undefined` is ruled out (Google guide): the alias lies about what the _config_ is. Add `| undefined` at the use site.
- **Deal with nullability where it arises.** A function that takes `T | undefined` and returns `T | undefined` has pushed the burden onto every caller. Narrow at the boundary; return `T` or throw.
- **`exactOptionalPropertyTypes` is not adopted** (§14), so `?` fields accept an explicit `undefined` today. Don't rely on the difference in either direction: a `?` field's meaning must be the same whether omitted or set to `undefined`.

### 4.7 `readonly` and immutability

The TypeScript team's guidelines state the assumption directly: treat objects and arrays as immutable by default after creation. In practice:

- **`readonly` on fields that shouldn't change** (`readonly permanent: boolean`) and **`as const` on literal data**.
- **Don't mutate a value owned by another module.** Return new values instead of editing in place; reserve mutation for the module that created the value.
- **No module-level mutable state** beyond an explicitly commented cache (§7.3) and process configuration. Module state is shared across every call and every consumer of the module; anything else belongs in a value threaded through arguments.

## 5. Modules and imports

The project is ESM (`"type": "module"`). Rules, in toolchain order:

- **Import extensions are mandatory and `.ts`**: `import { parseConfigFile } from "./config.ts";` — never `./config` or `./config.js`. Node requires extensions in ESM, and under type stripping the _TypeScript_ file is the runtime file. `tsc` checks this via `allowImportingTsExtensions` (with `noEmit`), per Node's documentation.
- **`import type` for type-only imports, always.** Node strips types but cannot know an import was type-only unless you say so; an unmarked type-only import is a _runtime_ error. `verbatimModuleSyntax` makes the compiler enforce what the runtime requires. Inline `import { type Foo, bar }` for mixed imports.
- **Named exports; no `export default` except a mandated entry point.** The Google guide rules against default exports (renaming hazard, no static checkability); the one exception here is the extension's `export default function (pi: ExtensionAPI)` because Pi's loader contract requires it.
- **No `require`, no `namespace`, no `/// <reference path="...">`.** All ruled out by the Google guide and unnecessary in this subset. Node's `createRequire` is the sanctioned way to reach CommonJS-only APIs (resolving files inside a dependency), from an ESM module.
- **No side-effect imports** (`import "./register-hooks.js"`). A module whose import has observable effects other than defining exports is hidden control flow; make the effect a called function.
- **Ordering is Biome's job.** The `organizeImports` assist sorts and groups on `npm run fix`; never hand-tune import order in review.

## 6. Functions

- **Explicit return types on exported functions.** Locally, inference is fine and better. On the module's public surface, an explicit type is checked documentation: callers see the contract, and a change that silently alters the return type fails the build instead of propagating. (The Google guide's reasoning: precise docs for readers, earlier failures on change.)
- **Arrow functions** for callbacks and for values; `function` declarations are fine for exported top-level API. No anonymous `function` expressions (TypeScript team guidelines).
- **Arrow parameters without redundant parens**: `chunk => ...`, not `(chunk) => ...` (TypeScript team guidelines).
- **Long positional lists become an options object.** More than two or three arguments of the same type invite transposition bugs the compiler can't catch. `prepareGuestImage({ configPath, projectRoot, consumer, ... })` — callers read as key:value, adding a field is non-breaking.
- **Overloads: collapse to optionals and unions first.** From the handbook's Do's and Don'ts: prefer one signature with optional trailing parameters; prefer a union parameter (`b: number | string`) over two signatures differing in one position; when overloads remain, the _most general signature goes last_, because resolution takes the first match. Callback parameters are non-optional — a callback that ignores an argument is always legal to provide (§4.1 of the same page: optional callback parameters change arity semantics).
- **Ignored callback returns are `void`.** `() => void`, never `() => any` — `void` keeps the compiler guarding against accidental use of a value you meant to discard (Do's and Don'ts).
- **No `this`-dependent free functions.** Arrow functions have no `this`; classes bind their own. A free function reaching for `this` is a design error (Google guide: `this` only inside class contexts).

## 7. Errors

### 7.1 Throw `Error` subclasses with names

- **One subclass per error category**, setting `name` in the constructor (a subclass's `name` defaults to `"Error"`, which erases the category from every log line):

  ```ts
  export class GuestImageError extends Error {
    readonly permanent: boolean;
    constructor(message: string, options?: { permanent?: boolean }) {
      super(message);
      this.name = "GuestImageError";
      this.permanent = options?.permanent ?? false;
    }
  }
  ```

  (The field itself, not the example, is the pattern: the subclass carries the _fields a handler needs_ — here, whether retrying can ever succeed.)

- **Never throw non-`Error` values.** strings and objects without stacks defeat `instanceof` narrowing and produce `throw x; is not...` logs. typescript-eslint's `only-throw-error` (strict-type-checked) rules the same.
- **Promise rejections are `Error` values too** — `reject(new GuestImageError(...))`, never `reject("message")` (typescript-eslint `prefer-promise-reject-errors`).

### 7.2 Component-prefixed messages

A thrown message is read in a log the component doesn't own. Prefix with the component name — `"Echoriad: invalid config (...)"` — and state the _file and field_ for configuration errors, because the reader's next question is always "which file, which field."

### 7.3 Module-level caches

The one sanctioned form of module state: a cache with a one-line comment saying what it holds and why a cache is correct. Its type is the value type or `undefined`, never `any`. Everything else (§4.7) goes through arguments.

### 7.4 Fail closed

Domain rule, stated because it constrains error _handling_ and not just error _shaping_: an error whose category means "retrying cannot succeed" must keep failing on every attempt. Encode the category as a field on the error class and let the caller branch on the field, never on a string match of the message.

## 8. Async and child processes

Node is single-threaded; async work is I/O, and child processes are I/O that can outlive you. The rules exist to prevent _unobserved_ work:

- **Every `async` function's Promise settles.** `await` it, `return` it, or `.catch` it. A statement-position Promise nothing observes is a _floating promise_ — the error typescript-eslint's most-cited rule, [`no-floating-promises`](https://typescript-eslint.io/rules/no-floating-promises/), exists for. Biome has no equivalent check, so this is a convention (§13): a Promise in statement position must be commented if left unobserved, and unobserved-with-comment should be rare.
- **`async` without `await` is a smell.** An `async` function that never awaits adds nothing but a wrapper; typescript-eslint's `require-await` (strict presets) rules it out. Drop the `async` and return the Promise.
- **Don't mix callbacks and Promises on one operation.** Pick per operation. Where a library offers both, wrap the callback form once with `new Promise` and settle it exactly once.
- **Child processes: wire every event that matters.** A `spawn` call must capture `stdout`/`stderr` (or pipe them to a log) and must observe `close`/`error`. A child nobody observes is an orphan that can hang the process or a build. `error` and `close` are distinct — `error` fires when the process _couldn't start_; handling only `close` misses it.
- **Timers are cleaned up or the test fails.** `setTimeout` in code under test keeps the event loop alive; clear the timer in the same abstraction that set it, and give tests a mode where the timer never arms (§12).
- **Prefer `AbortSignal` for cancellable work** rather than a hand-rolled boolean; `AbortSignal` composes with `fetch`, `fs` promises, and child processes (`signal` option), and the runtime does the unwiring.

## 9. Objects, classes, and data

- **Plain data is plain objects.** Config records, wire values, selections, and results are object literals typed by `interface`/`type` — not class instances. Classes are for values with _behavior and invariants_; data with no invariants gets no class.
- **A class exists when invariants must hold.** Fields a constructor validates, behavior that depends on internal state, values that must change together — that's a class (or a closed module). Its fields the class doesn't publish stay private (`#field`), not `_field` (§3).
- **Keyed object literals, always.** `{ image, buildConfig }`, never positional construction of the same shape — keyed literals survive field insertion and reordering.
- **One export per concept; closed surfaces.** Export what another module needs; nothing more. Every export is a compatibility commitment (TypeScript team guidelines: don't export unless the definition is shared across components).
- **Composition over hierarchy.** Deep inheritance chains are ruled out everywhere in the ecosystem (Google guide included); prefer union types and functions over class hierarchies, and object composition over `extends`.

## 10. Testing

Standard library only: [`node:test`](https://nodejs.org/api/test.html) and `node:assert/strict`. No Jest, no Vitest, no Chai — the toolchain decision is settled (§13).

```ts
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { parseConfigFile } from "../src/config.ts";

test("a config defining both image and buildConfig is invalid", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "echoriad-config-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  // ...
  assert.throws(
    () => parseConfigFile(configPath, "test config"),
    /may define only one/,
  );
});
```

- **A test passes by not throwing; an `async` test fails on a rejected Promise.** That's the whole contract of `node:test` — no framework assertions needed beyond `assert`.
- **`assert/strict`** — the strict variant, so `assert.deepEqual` is `strictEqual`-checked.
- **`t.after(cleanup)`** for teardown — runs even when the test body failed, and is the sanctioned replacement for `try`/`finally` around a whole test.
- **Scratch directories from `os.tmpdir()`** with a component-prefixed name (`echoriad-config-`), removed in `t.after`. Never write into the repo during a test.
- **Fixtures are real modules.** To test code that imports third-party modules, redirect the imports with a module load hook (`node:module`'s `registerHooks`) to a fixture module that exports the same shape with observable state. The fixture is a _module_, imported by the hook — not a string-replaced singleton. Fixture state is per-test-process and read through the fixture's exports, not through global variables.
- **Timers in tested code are disarmed by the fixture** (§8): a build child that "hangs" is simulated by a fixture mode, never by making the test itself slow.
- **Table-driven tests for parse-and-validate logic**: a case list (`{ name, input, want, wantErr }`) plus one `test` per case via a loop, `assert` per expectation. Failure output names the case.
- **Tests assert on _observable_ results** — return values, thrown messages, files written, exit codes — never on internals. A test that must reach into a private variable is testing the implementation, and it breaks on every refactor.
- **Colocation: `test/*.test.ts`**, one test file per source module plus integration tests (`build-process`, `extension-lifecycle`) that exercise the composition. The naming is the index.

## 11. Comments and JSDoc

- **JSDoc on exported surface.** The TypeScript team's guidelines rule: JSDoc-style comments on exported functions, interfaces, and classes. Start the comment with what the definition _is_ or _does_, in one line; add the invariants and the gotcha — the ordering dependency, the deliberate absence, the thing the next editor can't see from the code.
- **Comments state the _why_, never a citation.** A comment never points at `docs/`, an ADR, a spec, or a ticket. The reasoning a comment carries is compressed into the comment itself; the document trail is found through `docs/`, not footnoted from the source. (See the project's prose conventions.)
- **A comment that translates its name is a smell.** If the comment exists to explain a unit, a default, or what the function returns, the name is wrong — rename instead of annotating.
- **Unexported definitions are bare by default.** Module-private functions are named for their reader; they earn a comment only on a genuine gotcha.
- **Wrap comment prose at 80 columns.** Formatters reflow code, not comment text.

## 12. The lint profile: what Biome enforces and what the doc rules

`biome.json` is the _enforcement_ record; this section is the _intent_ record. They must agree, and when they disagree, one of them is wrong.

- **`recommended` rules everywhere** — Biome's default set, which covers the floor typescript-eslint's `recommended` defines (unused variables, unsafe types, `Function` types, and so on) with rule-for-rule parity for the constructs this subset uses.
- **`noExplicitAny`, `noNonNullAssertion`: error in `src/`, off in `test/**`** via a documented override. Rationale: §4.2 and §4.4 rule the assertions out of production code; test harnesses legitimately use loose fakes and post-setup assertions where the invariant was established by the harness itself. The override's scope is `test/**` and nothing else.
- **`noExplicitAny` stays a _warning_ by Biome's default severity even in `src/`** — Biome classifies severity per rule; the _project_ ruling (§4.2) is that a warning in `src/` is treated as a failure. Don't downgrade Biome's config to match a doc, and don't let a new warning accumulate.
- **Formatting**: two-space indent, 100-column lines, Biome's double quotes and trailing commas — config, not opinion (§13). `npm run fix` applies safe fixes; _unsafe_ fixes (removals, type changes) are applied by hand, reviewed.
- **What Biome cannot check is checked by review against this document**: floating promises (§8), `enum`-adjacent constructs the parser accepts, comment quality (§11), and the naming table (§3) beyond Biome's defaults.

## 13. Conventions to adopt for Echoriad

The local defaults, in one list. Override only with a comment justifying the divergence.

1. **Type stripping subset only** — no `enum`, no runtime `namespace`, no parameter properties, no import aliases (§1). `erasableSyntaxOnly` enforces it.
2. **`tsc --noEmit` with `strict: true` is a check gate** alongside `biome check .` — both run in `npm run check` (§2, §12).
3. **No explicit `any` in `src/`; `unknown` + narrow at every boundary** (§4.2). `any` is permitted for fakes in `test/**` only.
4. **`interface` for object shapes, `type` for unions and compositions** (§4.3).
5. **String-literal unions + `as const` maps; no enums** — toolchain-forced, ecosystem-agreed (§4.5).
6. **Narrow, don't assert** — `as` and `!` only at checked boundaries; `!` in `test/**` after setup only (§4.4).
7. **Absence is `undefined`; optional fields use `?`; no nullability in aliases** (§4.6).
8. **ESM with mandatory `.ts` extensions; `import type` always; named exports; no default export except the loader contract** (§5).
9. **Explicit return types on exported functions** (§6).
10. **One `Error` subclass per category, `name` set, fields for handlers, component-prefixed messages; fail closed by field, never by message-matching** (§7).
11. **Every Promise observed; every spawned child wired; timers cleaned up** (§8).
12. **Plain objects for data; classes only where invariants hold** (§9).
13. **`node:test` + `node:assert/strict` stdlib only; fixtures are real modules behind load hooks; no framework** (§10).
14. **Biome owns formatting and import order; `npm run fix` for safe fixes** (§12).
15. **Module-level mutable state only as a commented cache** (§4.7, §7.3).
16. **JSDoc on exported surface; no `docs/` citations in comments; 80-column comment wrap** (§11).

## 14. Open questions

Style points where the ecosystem is split, or where this project hasn't decided. Decide and delete.

1. **`exactOptionalPropertyTypes`.** Makes `?` fields reject explicit `undefined`, sharpening §4.6's "same meaning either way" from convention to compiler rule. Cost: every optional field assignment site must handle the distinction, and most libraries' types aren't written for it. Adopt when the project's own types dominate its surface; not before.
2. **`noUncheckedIndexedAccess`.** Makes `arr[i]` typed `T | undefined`. Catches real out-of-bounds bugs; costs an assertion at every legitimate index. Pair adoption with the indexing idiom (`.at()`, `Map`, or explicit bounds check). Biome can't check it; `tsc` can. Open.
3. **Runtime validation for configuration.** §4.2 rules `unknown` + narrow at boundaries; the question is _what narrows_: hand-rolled checks (current idiom — full control, verbose), a schema library (Zod, Valibot — one schema yields both the type and the validator, but adds a dependency and its generated types to every config surface). Decide when a third configuration shape appears.
4. **`tsc` as gate vs. type stripping drift.** Node checks nothing; `tsc` checks everything. A type error can therefore _exist_ without _failing_ until the gate runs — and a gate that runs too late (or not at all, in a host context) silently downgrades §2 to convention. Decide where `npm run check` runs besides the local shell (a hook, CI, a host-side wrapper).
5. **Generics depth.** The handbook's generic chapters define the full power set (conditional types, mapped types, `infer`). Most of it is a type-gym; the subset this project needs is one type parameter with a constraint (`Array<T>`, `Record<K, V>`, a `satisfies`-checked literal). Rule for now: reach for the stdlib/utility types first, a one-parameter generic second, and don't write `infer` without a failing use case.
6. **`Result`-style returns vs. exceptions.** Go-style `(value, error)` tuples in TypeScript (`Result<T, E>`) are a growing idiom; exceptions are the platform default and what `assert.throws`, `try`/`catch`, and every library assume. This project throws (§7). Revisit if error _handling_ (vs. error _shaping_) becomes a dominant pattern — the current error categories are thrown-and-caught-at-boundaries, which fits exceptions.
7. **Promise-lint parity.** §8 rules out floating promises by convention because Biome lacks the check. Options: add typescript-eslint (`strict-type-checked`) alongside Biome for the async rules only (`no-floating-promises`, `no-misused-promises`, `require-await`); or a custom Biome rule when one lands upstream. The dependency cost of a second linter is real; the check is the single highest-value one Biome misses. Decide when an unobserved Promise causes its first production hang.

---

## Appendix A: Quick reference

```ts
/**
 * Resolve the image source for a project: an existing image selector or a
 * build config to fingerprint and build.
 *
 * A configuration file may set "image" or "buildConfig", never both; the
 * resolution fails closed when a file defines both.
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import type { ProjectConfig } from "./config.ts";

const require = createRequire(import.meta.url);

type ImageSource = "selector" | "buildConfig";

const SOURCE_LABEL: Record<ImageSource, string> = {
  selector: "image selector",
  buildConfig: "build config",
};

export class ConfigError extends Error {
  readonly configPath: string;
  constructor(configPath: string, message: string) {
    super(`Echoriad: invalid config (${configPath}): ${message}`);
    this.name = "ConfigError";
    this.configPath = configPath;
  }
}

interface RawFileConfig {
  image?: unknown;
  buildConfig?: unknown;
}

function readJson(configPath: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(configPath, "utf8"));
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new ConfigError(configPath, `not valid JSON: ${error.message}`);
    }
    throw error;
  }
}

export function resolveSource(configPath: string): {
  source: ImageSource;
  value: string;
} {
  const parsed: unknown = readJson(configPath);
  if (parsed === null || typeof parsed !== "object") {
    throw new ConfigError(configPath, "must be a JSON object");
  }
  const { image, buildConfig } = parsed as RawFileConfig;

  if (image !== undefined && buildConfig !== undefined) {
    throw new ConfigError(configPath, `defines both "image" and "buildConfig"`);
  }
  if (typeof buildConfig === "string") {
    return { source: "buildConfig", value: buildConfig };
  }
  if (typeof image === "string") {
    return { source: "selector", value: image };
  }
  throw new ConfigError(
    configPath,
    `defines neither "image" nor "buildConfig"`,
  );
}
```

```ts
// test/config.test.ts
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { resolveSource } from "../src/config.ts";

test("a config defining both image and buildConfig fails closed", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "echoriad-config-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const configPath = path.join(dir, ".echoriad.json");
  fs.writeFileSync(
    configPath,
    JSON.stringify({ image: "a:latest", buildConfig: "b.json" }),
  );

  assert.throws(() => resolveSource(configPath), /defines both/);
});
```

## Appendix B: Reading list

This guide is distilled from:

- [TypeScript Handbook](https://www.typescriptlang.org/docs/handbook/intro.html) — the official reference; [Everyday Types](https://www.typescriptlang.org/docs/handbook/2/everyday-types.html) and [Narrowing](https://www.typescriptlang.org/docs/handbook/2/narrowing.html) are the two chapters this document leans on.
- [Do's and Don'ts](https://www.typescriptlang.org/docs/handbook/declaration-files/do-s-and-donts.html) — short, official, the source of §4.1 and §6's callback rules.
- [typescript-eslint rule docs](https://typescript-eslint.io/rules/) — each rule page carries the _why_; `no-explicit-any`, `no-floating-promises`, `no-unnecessary-condition`, and `consistent-type-definitions` are the four this document's type rules come from.
- [typescript-eslint presets](https://typescript-eslint.io/users/configs/) — `recommended` and `strict-type-checked` define the ecosystem's enforcement floor and ceiling; §12's profile is the subset Biome covers.
- [Biome linter](https://biomejs.dev/linter/) — rule categories, severity, safe vs. unsafe fixes.
- [Google TypeScript Style Guide](https://google.github.io/styleguide/tsguide.html) — the most complete external style guide; the source of §3's casing table, §4.6's nullability rulings, and §5's export rules.
- [TypeScript team coding guidelines](https://github.com/microsoft/TypeScript-wiki/blob/main/Coding-guidelines.md) — for contributors to the compiler, _not_ prescriptive for the community; quoted here only where it matches the ecosystem (JSDoc, `undefined` over `null`, the `I`-prefix ban).
- [Node.js TypeScript API](https://nodejs.org/api/typescript.html) — the type-stripping contract: §1's banned set, the mandatory `.ts` extensions, the recommended `tsconfig`.
- [node:test](https://nodejs.org/api/test.html) — the test contract: §10's assertions, `t.after`, fixture hooks.

---

_Compiled from the source repositories of the documents above (the website and rule sources are GitHub-hosted); where a ruling is this project's own, it is marked in §13. Ecosystem surveys were not available, so any claim of the form "most projects do X" is the author's judgment, not a citation._
