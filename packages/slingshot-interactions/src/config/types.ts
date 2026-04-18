import type { z } from 'zod';
import { interactionsPluginConfigSchema } from './schema';

/** Parsed interactions plugin config with defaults applied. */
export type InteractionsPluginConfig = z.output<typeof interactionsPluginConfigSchema>;
