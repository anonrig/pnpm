import path from 'path'
import semver from 'semver'
import partition from 'ramda/src/partition'
import { type Dependencies, type PackageManifest, type ReadPackageHook } from '@pnpm/types'
import { PnpmError } from '@pnpm/error'
import { parseOverrides } from '@pnpm/parse-overrides'
import normalizePath from 'normalize-path'
import { isSubRange } from './isSubRange'

export function createVersionsOverrider (
  overrides: Record<string, string>,
  rootDir: string
): ReadPackageHook {
  const parsedOverrides = tryParseOverrides(overrides)
  const [versionOverrides, genericVersionOverrides] = partition(({ parentPkg }) => parentPkg != null,
    parsedOverrides
      .map((override) => {
        let linkTarget: string | undefined
        if (override.newPref.startsWith('link:')) {
          linkTarget = path.join(rootDir, override.newPref.substring(5))
        }
        let linkFileTarget: string | undefined
        if (override.newPref.startsWith('file:')) {
          const pkgPath = override.newPref.substring(5)
          linkFileTarget = path.isAbsolute(pkgPath) ? pkgPath : path.join(rootDir, pkgPath)
        }
        return {
          ...override,
          linkTarget,
          linkFileTarget,
        }
      })
  ) as [VersionOverrideWithParent[], VersionOverride[]]
  return ((manifest: PackageManifest, dir?: string) => {
    const versionOverridesWithParent = versionOverrides.filter(({ parentPkg }) => {
      return (
        parentPkg.name === manifest.name &&
        (!parentPkg.pref || semver.satisfies(manifest.version, parentPkg.pref))
      )
    })
    overrideDepsOfPkg({ manifest, dir }, versionOverridesWithParent, genericVersionOverrides)

    return manifest
  }) as ReadPackageHook
}

function tryParseOverrides (overrides: Record<string, string>) {
  try {
    return parseOverrides(overrides)
  } catch (e) {
    throw new PnpmError('INVALID_OVERRIDES_SELECTOR', `${(e as PnpmError).message} in pnpm.overrides`)
  }
}

interface VersionOverride {
  parentPkg?: {
    name: string
    pref?: string
  }
  targetPkg: {
    name: string
    pref?: string
  }
  newPref: string
  linkTarget?: string
  linkFileTarget?: string
}

interface VersionOverrideWithParent extends VersionOverride {
  parentPkg: {
    name: string
    pref?: string
  }
}

function overrideDepsOfPkg (
  { manifest, dir }: { manifest: PackageManifest, dir: string | undefined },
  versionOverrides: VersionOverrideWithParent[],
  genericVersionOverrides: VersionOverride[]
) {
  if (manifest.dependencies != null) overrideDeps(versionOverrides, genericVersionOverrides, manifest.dependencies, dir)
  if (manifest.optionalDependencies != null) overrideDeps(versionOverrides, genericVersionOverrides, manifest.optionalDependencies, dir)
  if (manifest.devDependencies != null) overrideDeps(versionOverrides, genericVersionOverrides, manifest.devDependencies, dir)
}

function overrideDeps (
  versionOverrides: VersionOverrideWithParent[],
  genericVersionOverrides: VersionOverride[],
  deps: Dependencies,
  dir: string | undefined
) {
  for (const [name, pref] of Object.entries(deps)) {
    const versionOverride =
    pickMostSpecificVersionOverride(
      versionOverrides.filter(
        ({ targetPkg }) =>
          targetPkg.name === name && isSubRange(targetPkg.pref, pref)
      )
    ) ??
    pickMostSpecificVersionOverride(
      genericVersionOverrides.filter(
        ({ targetPkg }) =>
          targetPkg.name === name && isSubRange(targetPkg.pref, pref)
      )
    )
    if (!versionOverride) continue

    if (versionOverride.linkTarget && dir) {
      deps[versionOverride.targetPkg.name] = `link:${normalizePath(
        path.relative(dir, versionOverride.linkTarget)
      )}`
      continue
    }
    if (versionOverride.linkFileTarget) {
      deps[
        versionOverride.targetPkg.name
      ] = `file:${versionOverride.linkFileTarget}`
      continue
    }
    deps[versionOverride.targetPkg.name] = versionOverride.newPref
  }
}

function pickMostSpecificVersionOverride (versionOverrides: VersionOverride[]): VersionOverride | undefined {
  return versionOverrides.sort((a, b) => isSubRange(b.targetPkg.pref ?? '', a.targetPkg.pref ?? '') ? -1 : 1)[0]
}
