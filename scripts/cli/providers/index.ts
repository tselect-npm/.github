/**
 * The provider registry, in application order.
 *
 * `rulesets` is last because it is the only one that can refuse to act on a
 * repo — `ci-required` needs evidence that CI has run — and when it does, the
 * rest of the configuration is already in place rather than half-applied behind
 * it. `files` comes just before it because writing the CI caller is the step
 * that eventually makes `ci-required` applicable.
 */
import { filesProvider } from './files.ts';
import { labelsProvider } from './labels.ts';
import { rulesetsProvider } from './rulesets.ts';
import { securityProvider } from './security.ts';
import { settingsProvider } from './settings.ts';
import type { Provider } from './types.ts';

export const PROVIDERS: Provider[] = [
  settingsProvider,
  securityProvider,
  labelsProvider,
  filesProvider,
  rulesetsProvider,
];

export const PROVIDER_NAMES = PROVIDERS.map((provider) => provider.name);

/**
 * Apply `--only` / `--skip`.
 *
 * An unknown name is an error rather than a no-op: `--only ruleset` quietly
 * doing nothing, when `rulesets` was meant, is exactly the kind of silent
 * success this tool exists to eliminate.
 */
export function selectProviders(only: string[], skip: string[]): Provider[] {
  for (const name of [...only, ...skip]) {
    if (!PROVIDER_NAMES.includes(name)) {
      throw new Error(`unknown provider "${name}"; known providers are ${PROVIDER_NAMES.join(', ')}`);
    }
  }

  return PROVIDERS.filter(
    (provider) =>
      (only.length === 0 || only.includes(provider.name)) && !skip.includes(provider.name),
  );
}
