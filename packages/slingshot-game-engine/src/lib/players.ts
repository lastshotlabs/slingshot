/**
 * Player management.
 *
 * Role assignment, team balancing, player subsets, and player state machine.
 * All mutations happen within the session mutex.
 *
 * See spec §6 for the full contract.
 */
import type {
  GameDefinition,
  GamePlayerState,
  RoleAssignmentContext,
  SeededRng,
} from '../types/models';

/** Role assignment result for a player. */
export interface RoleAssignment {
  userId: string;
  role: string;
  visiblePlayers: Array<{
    userId: string;
    role: string;
    displayName: string;
  }>;
}

/**
 * Assign custom game roles to players.
 *
 * Flow (from spec §6.5):
 * 1. Collect all enabled role definitions.
 * 2. Compute count for each role.
 * 3. Validate total counts == player count.
 * 4. Shuffle using seeded RNG.
 * 5. Assign fixed-count roles first, then 'remaining'.
 * 6. Compute role visibility per player.
 */
export function assignRoles(
  gameDef: GameDefinition,
  players: GamePlayerState[],
  rng: SeededRng,
): RoleAssignment[] {
  const roleEntries = Object.entries(gameDef.roles);
  if (roleEntries.length === 0) {
    return players.map(p => ({
      userId: p.userId,
      role: 'player',
      visiblePlayers: [],
    }));
  }

  const ctx: RoleAssignmentContext = {
    rules: gameDef.presets,
    playerCount: players.length,
    teamCount: gameDef.teams
      ? typeof gameDef.teams.count === 'number'
        ? gameDef.teams.count
        : 0
      : 0,
  };

  // Filter enabled roles
  const enabledRoles: Array<{ name: string; count: number | 'remaining' }> = [];
  for (const [name, def] of roleEntries) {
    const enabled =
      def.enabled === undefined
        ? true
        : typeof def.enabled === 'function'
          ? def.enabled(ctx)
          : def.enabled;

    if (!enabled) continue;

    const count = typeof def.count === 'function' ? def.count(ctx) : def.count;
    enabledRoles.push({ name, count });
  }

  // Shuffle players
  const shuffled = rng.shuffle([...players]);

  // Assign fixed-count roles first
  const assignments = new Map<string, string>();
  let assignIndex = 0;

  for (const role of enabledRoles) {
    if (role.count === 'remaining') continue;
    const count = role.count;
    for (let i = 0; i < count && assignIndex < shuffled.length; i++) {
      assignments.set(shuffled[assignIndex].userId, role.name);
      assignIndex++;
    }
  }

  // Assign 'remaining' roles
  const remainingRole = enabledRoles.find(r => r.count === 'remaining');
  if (remainingRole) {
    while (assignIndex < shuffled.length) {
      assignments.set(shuffled[assignIndex].userId, remainingRole.name);
      assignIndex++;
    }
  }

  // Compute visibility
  const result: RoleAssignment[] = [];
  for (const player of players) {
    const role = assignments.get(player.userId) ?? 'player';
    const visibilityRule = gameDef.roleVisibility[role];

    let visibleRoles: string[] = [];
    if ('sees' in visibilityRule) {
      const emptyRules: Record<string, unknown> = {};
      visibleRoles =
        typeof visibilityRule.sees === 'function'
          ? visibilityRule.sees(players.length, emptyRules)
          : visibilityRule.sees;
    }

    const visiblePlayers: RoleAssignment['visiblePlayers'] = [];
    if (visibleRoles.length > 0) {
      for (const other of players) {
        if (other.userId === player.userId) continue;
        const otherRole = assignments.get(other.userId) ?? 'player';
        if (visibleRoles.includes(otherRole)) {
          visiblePlayers.push({
            userId: other.userId,
            role: otherRole,
            displayName: other.displayName,
          });
        }
      }
    }

    result.push({ userId: player.userId, role, visiblePlayers });
  }

  return result;
}

/**
 * Assign players to teams.
 *
 * For 'auto': balance evenly by player count.
 * For 'random': shuffle and distribute.
 */
export function assignTeams(
  gameDef: GameDefinition,
  players: GamePlayerState[],
  rng: SeededRng,
): Map<string, string> {
  const teamDef = gameDef.teams;
  if (!teamDef) return new Map();

  const emptyTeamRules: Record<string, unknown> = {};
  const teamCount =
    typeof teamDef.count === 'function'
      ? teamDef.count({
          rules: emptyTeamRules,
          playerCount: players.length,
        })
      : teamDef.count;

  // Generate team names
  const teamNames: string[] = [];
  for (let i = 0; i < teamCount; i++) {
    teamNames.push(teamDef.names?.[i] ?? `Team ${i + 1}`);
  }

  const assignment = new Map<string, string>();

  if (teamDef.assignment === 'random') {
    const shuffled = rng.shuffle([...players]);
    for (let i = 0; i < shuffled.length; i++) {
      assignment.set(shuffled[i].userId, teamNames[i % teamCount]);
    }
  } else if (teamDef.assignment === 'auto') {
    // Round-robin balanced assignment
    const activePlayers = players.filter(p => !p.isSpectator);
    for (let i = 0; i < activePlayers.length; i++) {
      assignment.set(activePlayers[i].userId, teamNames[i % teamCount]);
    }
  }

  return assignment;
}

/**
 * Get players matching a filter.
 */
export function filterPlayers(
  players: readonly GamePlayerState[],
  filter: {
    role?: string;
    team?: string;
    state?: string | string[];
    connected?: boolean;
    isSpectator?: boolean;
  },
): GamePlayerState[] {
  return players.filter(p => {
    if (filter.role !== undefined && p.role !== filter.role) return false;
    if (filter.team !== undefined && p.team !== filter.team) return false;
    if (filter.state !== undefined) {
      if (Array.isArray(filter.state)) {
        if (!filter.state.includes(p.playerState ?? '')) return false;
      } else {
        if (p.playerState !== filter.state) return false;
      }
    }
    if (filter.connected !== undefined && p.connected !== filter.connected) return false;
    if (filter.isSpectator !== undefined && p.isSpectator !== filter.isSpectator) return false;
    return true;
  });
}
