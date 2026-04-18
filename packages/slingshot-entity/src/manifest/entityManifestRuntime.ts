import type { EntityAdapterTransformRegistry } from './entityAdapterTransformRegistry';
import type { EntityHandlerRegistry } from './entityHandlerRegistry';
import type { EntityPluginHookRegistry } from './entityPluginHookRegistry';

/**
 * Runtime services used by manifest-driven entity plugins.
 *
 * Manifest JSON stays serializable; any runtime behavior required by handler
 * refs, adapter transforms, or lifecycle hooks is resolved through this object.
 */
export interface EntityManifestRuntime {
  /** Named `custom` operation handlers for manifest operations. */
  customHandlers?: EntityHandlerRegistry;
  /** Named adapter transforms referenced by `adapterTransforms`. */
  adapterTransforms?: EntityAdapterTransformRegistry;
  /** Named lifecycle hooks referenced by `hooks.afterAdapters`. */
  hooks?: EntityPluginHookRegistry;
}
