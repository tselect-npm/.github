# TSelect

A collection of small, focused, fully-typed TypeScript utilities for Node.js, published under the [`@tselect`](https://www.npmjs.com/org/tselect) namespace on npm.

Each package is developed and released independently in its own repository.

## Packages

| Package | Description | npm |
| --- | --- | --- |
| [`@tselect/access-control`](https://github.com/tselect-npm/access-control) | Simple, flexible RBAC / ABAC access control for Node.js and TypeScript. | [![npm](https://img.shields.io/npm/v/@tselect/access-control.svg?style=flat-square)](https://www.npmjs.com/package/@tselect/access-control) |
| [`@tselect/countries`](https://github.com/tselect-npm/countries) | Country, currency and language enums and data (ISO 3166 / 4217 / 639). | [![npm](https://img.shields.io/npm/v/@tselect/countries.svg?style=flat-square)](https://www.npmjs.com/package/@tselect/countries) |
| [`@tselect/http-method`](https://github.com/tselect-npm/http-method) | HTTP method enum and type guards / case utilities. | [![npm](https://img.shields.io/npm/v/@tselect/http-method.svg?style=flat-square)](https://www.npmjs.com/package/@tselect/http-method) |
| [`@tselect/schema`](https://github.com/tselect-npm/schema) | Typed, composable, programmatic JSON schemas. | [![npm](https://img.shields.io/npm/v/@tselect/schema.svg?style=flat-square)](https://www.npmjs.com/package/@tselect/schema) |
| [`@tselect/status-code`](https://github.com/tselect-npm/status-code) | HTTP status code enum and classification helpers. | [![npm](https://img.shields.io/npm/v/@tselect/status-code.svg?style=flat-square)](https://www.npmjs.com/package/@tselect/status-code) |
| [`@tselect/thrown`](https://github.com/tselect-npm/thrown) | Handle specific exceptions in TypeScript like a classic OOP `try/catch`. | [![npm](https://img.shields.io/npm/v/@tselect/thrown.svg?style=flat-square)](https://www.npmjs.com/package/@tselect/thrown) |
| [`@tselect/url`](https://github.com/tselect-npm/url) | Small URL string utilities (slashes, protocol, join). | [![npm](https://img.shields.io/npm/v/@tselect/url.svg?style=flat-square)](https://www.npmjs.com/package/@tselect/url) |

## At a glance

```typescript
// @tselect/status-code
import { StatusCode, is5xx } from '@tselect/status-code';
StatusCode.OK;                                // 200
is5xx(StatusCode.INTERNAL_SERVER_ERROR);      // true

// @tselect/http-method
import { HTTPMethod, isHTTPMethod } from '@tselect/http-method';
HTTPMethod.GET;                               // get
isHTTPMethod('get');                          // true

// @tselect/countries
import { Countries, CountryCode } from '@tselect/countries';
Countries.get(CountryCode.AC).getMainCurrency().getDecimals(); // 2

// @tselect/schema
import { object, email } from '@tselect/schema';
object({ foo: email() });                     // { type: 'object', additionalProperties: false, ... }

// @tselect/url
import * as URL from '@tselect/url';
URL.ensureSlashes('/foo', { leading: false, trailing: true }); // foo/

// @tselect/thrown
import { thrown } from '@tselect/thrown';
try { doSomething(); }
catch (err: any) { thrown(err).catch(TypeError, e => {/* ... */}).rethrowUncaught(); }
```

## Design principles

- **Small and single-purpose** — each package solves one problem and has minimal dependencies.
- **Fully typed** — first-class TypeScript, shipping `.d.ts` typings for editor autocompletion.
- **CommonJS output** — compiled to `dist/` and consumed from `main` + `typings`.
- **MIT licensed.**

## License

MIT © Sylvain Estevez
