import type { NotificationRecord } from '@lastshotlabs/slingshot-core';
import type { CompiledPushFormatterTable } from './state';
import type { PushFormatterFn, PushFormatterTemplate } from './types/config';

function resolvePath(source: unknown, path: string): unknown {
  let current = source;
  for (const part of path.split('.')) {
    if (current === null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function stringifyTemplateValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol') {
    return '';
  }

  return JSON.stringify(value);
}

function interpolate(template: string, notification: NotificationRecord): string {
  return template.replace(/\$\{([^}]+)\}/g, (_match, path: string) => {
    const value = resolvePath({ notification }, path.trim());
    return value == null ? '' : stringifyTemplateValue(value);
  });
}

/**
 * Compile manifest-safe formatter templates into a runtime formatter table.
 *
 * @param templates - Formatter templates keyed by notification type.
 * @returns A formatter table that supports lookup, runtime registration, and
 *   fallback formatting.
 */
export function compilePushFormatters(
  templates: Partial<Record<string, PushFormatterTemplate>> = {},
): CompiledPushFormatterTable {
  const runtimeFormatters = new Map<string, PushFormatterFn>();

  const table: CompiledPushFormatterTable = {
    templates: Object.freeze({ ...templates }),
    resolve(type) {
      const runtime = runtimeFormatters.get(type);
      if (runtime) return runtime;

      const template = templates[type];
      if (!template) return null;

      return (notification, defaults) => {
        const resolvedBadge =
          template.badgeField == null
            ? undefined
            : resolvePath({ notification }, template.badgeField);
        const badgeValue =
          resolvedBadge == null ? defaults?.badge : stringifyTemplateValue(resolvedBadge);

        return {
          title: interpolate(template.titleTemplate, notification),
          body: template.bodyTemplate
            ? interpolate(template.bodyTemplate, notification)
            : undefined,
          icon: template.iconUrl ?? defaults?.icon,
          badge: badgeValue,
          url: defaults?.url,
          data: Object.fromEntries(
            Object.entries(template.dataTemplate ?? {}).map(([key, value]) => [
              key,
              interpolate(value, notification),
            ]),
          ),
        };
      };
    },
    register(type, formatter) {
      runtimeFormatters.set(type, formatter);
    },
    format(notification, defaults) {
      const formatter = table.resolve(notification.type);
      if (formatter) {
        return formatter(notification, defaults);
      }
      return {
        title: `${notification.source}: ${notification.type}`,
        url: defaults?.url,
        icon: defaults?.icon,
        badge: defaults?.badge,
        data: notification.data ? { ...notification.data } : undefined,
      };
    },
  };

  return table;
}
