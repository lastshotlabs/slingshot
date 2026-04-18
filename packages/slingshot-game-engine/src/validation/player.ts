/**
 * Zod schemas for player join/update validation.
 *
 * These schemas validate REST request bodies for player endpoints.
 * See spec §26.3 for the full REST API surface.
 *
 * @internal
 */
import { z } from 'zod';

/** Schema for `POST /game/sessions/:id/players/:userId/kick` request body. */
export const PlayerKickInputSchema = z.object({
  ban: z
    .boolean()
    .optional()
    .default(false)
    .describe('If true, the kicked player cannot rejoin this session. Default: false.'),
});

/** Schema for `PATCH /game/sessions/:id/players/:userId/team` request body. */
export const PlayerTeamAssignInputSchema = z.object({
  team: z.string().min(1).describe('Team name to assign the player to.'),
});

/** Schema for `PATCH /game/sessions/:id/players/:userId/role` request body. */
export const PlayerRoleAssignInputSchema = z.object({
  role: z.enum(['host', 'player', 'spectator']).describe('Built-in role to assign.'),
});

/** Schema for lobby update WS messages (host changing lobby config). */
export const LobbyUpdateInputSchema = z.object({
  rules: z.record(z.string(), z.unknown()).optional().describe('Partial rules update.'),
  preset: z.string().optional().describe('Preset to apply.'),
  content: z
    .object({
      provider: z.string().min(1),
      input: z.unknown().optional(),
    })
    .optional()
    .describe('Content source update.'),
});

export type PlayerKickInput = z.output<typeof PlayerKickInputSchema>;
export type PlayerTeamAssignInput = z.output<typeof PlayerTeamAssignInputSchema>;
export type PlayerRoleAssignInput = z.output<typeof PlayerRoleAssignInputSchema>;
export type LobbyUpdateInput = z.output<typeof LobbyUpdateInputSchema>;
