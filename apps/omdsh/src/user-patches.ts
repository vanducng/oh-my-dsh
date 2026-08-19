/**
 * Native omdsh user layer discovery.
 *
 * This module owns only deployment discovery for the two optional user-layer
 * files in the omdsh namespace of the Harness home. `omdsh/plugins.yml` is an
 * entry list of out-of-tree plugin rows mounted through its own include, so
 * bare package names resolve beside that file (`$DSH_HOME/omdsh/node_modules`).
 * `omdsh/cordis.patch.yml` is a patch list applied after the shipped
 * composition and the MCP insert patches, so the user layer wins. Patch
 * semantics, `!!js` expressions, and fail-loud validation remain owned by the
 * Harness patch loader and include.
 * @module @vanducng/oh-my-dsh
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { loadOptionalPatches } from '@deepseek-ai/dsh-app-boot'
import { omdshHome } from './mcp-config.ts'

/** The user patch layer inside the omdsh namespace of the Harness home. */
export const USER_PATCH_FILENAME = 'cordis.patch.yml'

/** The out-of-tree plugin entry list inside the omdsh namespace. */
export const USER_PLUGINS_FILENAME = 'plugins.yml'

/** One include insert produced for the user plugin entry list. */
export interface UserPluginsPatch {
  insert: [{ id: 'omdsh-user-plugins'; name: 'cordis:include'; config: { path: string } }]
}

/** Resolve the user patch layer path under the omdsh namespace. */
export function userPatchPath(environment: NodeJS.ProcessEnv = process.env): string {
  return join(omdshHome(environment), 'omdsh', USER_PATCH_FILENAME)
}

/** Resolve the user plugin entry-list path under the omdsh namespace. */
export function userPluginsPath(environment: NodeJS.ProcessEnv = process.env): string {
  return join(omdshHome(environment), 'omdsh', USER_PLUGINS_FILENAME)
}

/**
 * Turn a present user plugin entry list into its include insert. The include
 * anchors module resolution beside the file, and a present file that is not
 * a YAML entry list fails the boot loudly inside the include itself.
 */
export function userPluginsPatches(environment: NodeJS.ProcessEnv = process.env): UserPluginsPatch[] {
  const path = userPluginsPath(environment)
  if (!existsSync(path)) return []
  return [{ insert: [{ id: 'omdsh-user-plugins', name: 'cordis:include', config: { path } }] }]
}

/**
 * Load the optional user patch layer. A missing file means "no layer"; a
 * present file that cannot parse or is not a patch list fails loud.
 */
export function loadUserPatches(environment: NodeJS.ProcessEnv = process.env): NonNullable<ReturnType<typeof loadOptionalPatches>> {
  return loadOptionalPatches('omdsh', userPatchPath(environment)) ?? []
}
