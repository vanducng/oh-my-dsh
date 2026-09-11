/**
 * npm overrides for a packed CLI install. Exact DSH pins in this repo do not
 * stop npm from hoisting a newer `^0.1.5-rc.1` peer (`0.1.5-rc.2` today) next
 * to the nested 0.1.5-rc.1 copy. Two `dsh-scope` packages mean `createScope`
 * and `systemPrompt.section()` disagree, so a preset persona registers on the
 * host and collides with `deployment:persona-prefix`.
 */

export const DSH_COHORT = '0.1.5-rc.1'

export const CORDIS_COHORT = {
  '@deepseek-ai/cordis': '4.0.2',
  '@deepseek-ai/cordis-plugin-include': '1.0.7',
  '@deepseek-ai/cordis-plugin-group': '1.0.2',
}

/** Transitives that share identity symbols and are not always direct deps. */
const IDENTITY_PACKAGES = [
  '@deepseek-ai/dsh-scope',
  '@deepseek-ai/dsh-system-prompt',
  '@deepseek-ai/dsh-invariants',
]

/**
 * @param {Array<{ dependencies?: Record<string, string> }>} manifests
 * @returns {Record<string, string>}
 */
export function packedInstallOverrides(...manifests) {
  const overrides = { ...CORDIS_COHORT }
  for (const name of IDENTITY_PACKAGES) overrides[name] = DSH_COHORT
  for (const manifest of manifests) {
    for (const name of Object.keys(manifest.dependencies ?? {})) {
      if (name.startsWith('@deepseek-ai/dsh-')) overrides[name] = DSH_COHORT
    }
  }
  return overrides
}
