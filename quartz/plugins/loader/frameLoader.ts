import { frameRegistry } from "../../components/frames/registry"
import { PluginManifest } from "./types"
import { PageFrame } from "../../components/frames/types"
import { getPluginSubpathEntry, toFileUrl } from "./gitLoader"

export async function loadFramesFromPackage(
  pluginName: string,
  manifest: PluginManifest | null,
): Promise<void> {
  if (!manifest?.frames) return

  try {
    const framesPath = getPluginSubpathEntry(pluginName, "./frames")

    let framesModule: Record<string, unknown>
    if (framesPath) {
      framesModule = await import(toFileUrl(framesPath))
    } else {
      framesModule = await import(`${pluginName}/frames`)
    }

    for (const [exportName, _frameMeta] of Object.entries(manifest.frames)) {
      const frame = framesModule[exportName]
      if (!frame) {
        console.warn(
          `Frame "${exportName}" declared in manifest but not found in ${pluginName}/frames`,
        )
        continue
      }

      const pageFrame = frame as PageFrame
      if (!pageFrame.name || typeof pageFrame.render !== "function") {
        console.warn(
          `Frame "${exportName}" from ${pluginName} is not a valid PageFrame (missing name or render)`,
        )
        continue
      }

      // Register under the frame's declared name
      frameRegistry.register(pageFrame.name, pageFrame, pluginName)
    }
  } catch (err) {
    // Local change: fail instead of warning, so the build stops (see config-loader.ts).
    if (manifest.frames && Object.keys(manifest.frames).length > 0) {
      throw new Error(
        `Plugin "${pluginName}" declares frames but failed to load them: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }
}
