import { z } from 'zod';

/** Button component schema. */
export const buttonSchema = z
  .object({
    type: z.literal('button'),
    actionId: z.string().min(1).max(100).optional(),
    label: z.string().min(1).max(80),
    style: z.enum(['primary', 'secondary', 'danger', 'success', 'link']).optional(),
    url: z.url().optional(),
    disabled: z.boolean().optional(),
    permission: z.string().min(1).max(120).optional(),
  })
  .superRefine((value, ctx) => {
    if (value.style === 'link' && value.url == null) {
      ctx.addIssue({ code: 'custom', message: 'link buttons require url' });
    }
    if (value.style !== 'link' && value.actionId == null) {
      ctx.addIssue({
        code: 'custom',
        message: 'interactive buttons require actionId',
      });
    }
  });

/** Select-menu option schema. */
export const selectOptionSchema = z.object({
  label: z.string().min(1).max(80),
  value: z.string().min(1).max(100),
  description: z.string().max(120).optional(),
});

/** Select-menu component schema. */
export const selectMenuSchema = z.object({
  type: z.literal('select'),
  kind: z.literal('string').optional(),
  actionId: z.string().min(1).max(100),
  placeholder: z.string().max(120).optional(),
  options: z.array(selectOptionSchema).min(1).max(25),
  minValues: z.number().int().min(0).max(25).optional(),
  maxValues: z.number().int().min(1).max(25).optional(),
  disabled: z.boolean().optional(),
  permission: z.string().min(1).max(120).optional(),
});

/** Modal text-input schema. */
export const textInputSchema = z.object({
  type: z.literal('textInput'),
  actionId: z.string().min(1).max(100),
  label: z.string().min(1).max(80),
  placeholder: z.string().max(120).optional(),
  value: z.string().max(2000).optional(),
  required: z.boolean().optional(),
});

/** Union schema for actionable components. */
export const actionComponentSchema = z.discriminatedUnion('type', [
  buttonSchema,
  selectMenuSchema,
  textInputSchema,
]);

/** Action-row schema. */
export const actionRowSchema = z.object({
  type: z.literal('actionRow'),
  children: z.array(actionComponentSchema).min(1).max(5),
});

/** Component-tree schema attached to a message. */
export const componentTreeSchema = z.array(actionRowSchema).max(5);

/** Modal payload schema returned by handlers. */
export const modalSchema = z.object({
  title: z.string().min(1).max(100),
  actionId: z.string().min(1).max(100),
  components: componentTreeSchema,
});
