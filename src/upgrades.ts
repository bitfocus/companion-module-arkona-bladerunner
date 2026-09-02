import type { CompanionStaticUpgradeScript } from '@companion-module/base'
import type { ModuleConfig, ModuleSecrets } from './config.js'

/**
 * No upgrade scripts yet: the module has not been released, so there are no stored configs from an
 * older version to migrate. Once it ships, remember that a script added here can never be removed.
 */
export const UpgradeScripts: CompanionStaticUpgradeScript<ModuleConfig, ModuleSecrets>[] = []
