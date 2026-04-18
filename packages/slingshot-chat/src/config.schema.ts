// packages/slingshot-chat/src/config.schema.ts
import { z } from 'zod';

/**
 * Zod schema for `ChatPermissionsConfig`.
 * @internal
 */
export const chatPermissionsConfigSchema = z.object({
  createRoom: z
    .array(z.string())
    .optional()
    .describe(
      'Roles allowed to create chat rooms. Omit to leave room-creation authorization to the surrounding app.',
    ),
  sendMessage: z
    .array(z.string())
    .optional()
    .describe(
      'Roles allowed to send messages. Omit to leave message-send authorization to the surrounding app.',
    ),
  deleteMessage: z
    .array(z.string())
    .optional()
    .describe(
      'Roles allowed to delete messages. Omit to leave delete authorization to the surrounding app.',
    ),
  pinMessage: z
    .array(z.string())
    .optional()
    .describe(
      'Roles allowed to pin messages. Omit to leave pin authorization to the surrounding app.',
    ),
  addMember: z
    .array(z.string())
    .optional()
    .describe(
      'Roles allowed to add room members. Omit to leave membership authorization to the surrounding app.',
    ),
});

/**
 * Zod schema for `ChatPluginConfig`. Validated at construction time in `createChatPlugin()`.
 * @internal
 */
export const chatPluginConfigSchema = z.object({
  storeType: z
    .enum(['memory', 'redis', 'sqlite', 'postgres', 'mongo'])
    .describe(
      'Persistence backend for chat rooms and messages. One of: memory, redis, sqlite, postgres, mongo.',
    ),
  mountPath: z
    .string()
    .min(1)
    .optional()
    .default('/chat')
    .describe('URL path prefix for chat routes. Default: /chat.'),
  tenantId: z
    .string()
    .min(1)
    .optional()
    .describe(
      'Fixed tenant ID applied to chat operations. Omit to resolve tenancy from the surrounding app context.',
    ),
  permissions: chatPermissionsConfigSchema
    .optional()
    .default({})
    .describe('Role requirements for chat actions. Default: {}.'),
  pageSize: z
    .number()
    .int()
    .positive()
    .max(200)
    .optional()
    .default(50)
    .describe('Default number of messages returned per paginated request. Default: 50.'),
  enablePresence: z
    .boolean()
    .optional()
    .default(true)
    .describe('Enable presence tracking for connected chat users. Default: true.'),
  encryption: z
    .discriminatedUnion('provider', [
      z.object({
        provider: z.literal('none').describe('Disable message encryption for stored payloads.'),
      }),
      z.object({
        provider: z.literal('aes-gcm').describe('Encrypt message payloads with AES-GCM.'),
        keyBase64: z
          .string()
          .min(1)
          .describe('Base64-encoded AES-GCM key used to encrypt and decrypt messages.'),
        aadPrefix: z
          .string()
          .min(1)
          .optional()
          .describe(
            'Additional authenticated data prefix applied to every encrypted payload. Omit to use no prefix.',
          ),
      }),
    ])
    .optional()
    .describe(
      'Message encryption configuration. Omit to store messages without plugin-managed encryption.',
    ),
});
