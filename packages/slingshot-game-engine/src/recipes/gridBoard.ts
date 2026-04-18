/**
 * 2D grid board recipe.
 *
 * Utilities for creating and manipulating 2D grids with adjacency,
 * pathfinding (BFS), and flood fill operations.
 *
 * See spec §23.2 for the API contract.
 */

/** A 2D grid represented as a flat array with dimensions. */
export interface Grid<T> {
  readonly width: number;
  readonly height: number;
  cells: T[];
}

/** Grid coordinate. */
export interface Position {
  readonly x: number;
  readonly y: number;
}

/** Options for creating a grid. */
export interface CreateGridOptions<T> {
  /** Value to fill all cells with. */
  fill: T;
}

/** Options for neighbor queries. */
export interface NeighborOptions {
  /** Include diagonal neighbors. Default: false. */
  diagonal?: boolean;
}

/** Options for BFS pathfinding. */
export interface PathOptions<T> {
  /** Return true if the cell is walkable. */
  walkable: (cell: T, pos: Position) => boolean;
}

/** Options for flood fill. */
export interface FloodFillOptions<T> {
  /** Value to match for fill expansion. */
  match: T;
  /** Value to fill matched cells with. */
  fill: T;
}

/**
 * Create a 2D grid filled with a default value.
 */
function create<T>(width: number, height: number, options: CreateGridOptions<T>): Grid<T> {
  return {
    width,
    height,
    cells: Array(width * height).fill(options.fill) as T[],
  };
}

/** Get the value at a grid position. */
function get<T>(grid: Grid<T>, x: number, y: number): T | undefined {
  if (x < 0 || x >= grid.width || y < 0 || y >= grid.height) return undefined;
  return grid.cells[y * grid.width + x];
}

/** Set the value at a grid position. */
function set<T>(grid: Grid<T>, x: number, y: number, value: T): void {
  if (x < 0 || x >= grid.width || y < 0 || y >= grid.height) return;
  grid.cells[y * grid.width + x] = value;
}

/** Check if a position is within bounds. */
function inBounds<T>(grid: Grid<T>, x: number, y: number): boolean {
  return x >= 0 && x < grid.width && y >= 0 && y < grid.height;
}

/**
 * Get neighbor positions of a cell.
 *
 * @returns Array of neighbor values (up, down, left, right; optionally diagonals).
 */
function neighbors<T>(
  grid: Grid<T>,
  x: number,
  y: number,
  options?: NeighborOptions,
): Array<{ x: number; y: number; value: T }> {
  const result: Array<{ x: number; y: number; value: T }> = [];
  const dirs: [number, number][] = [
    [0, -1], // up
    [0, 1], // down
    [-1, 0], // left
    [1, 0], // right
  ];

  if (options?.diagonal) {
    dirs.push([-1, -1], [1, -1], [-1, 1], [1, 1]);
  }

  for (const [dx, dy] of dirs) {
    const nx = x + dx;
    const ny = y + dy;
    if (inBounds(grid, nx, ny)) {
      result.push({ x: nx, y: ny, value: grid.cells[ny * grid.width + nx] });
    }
  }

  return result;
}

/**
 * Find a path between two positions using BFS.
 *
 * @returns Array of positions from start to end (inclusive), or null if no path exists.
 */
function findPath<T>(
  grid: Grid<T>,
  start: Position,
  end: Position,
  options: PathOptions<T>,
): Position[] | null {
  if (!inBounds(grid, start.x, start.y) || !inBounds(grid, end.x, end.y)) {
    return null;
  }

  const key = (x: number, y: number) => `${x},${y}`;
  const visited = new Set<string>();
  const parent = new Map<string, Position>();
  const queue: Position[] = [start];
  visited.add(key(start.x, start.y));

  const dirs: [number, number][] = [
    [0, -1],
    [0, 1],
    [-1, 0],
    [1, 0],
  ];

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) break;

    if (current.x === end.x && current.y === end.y) {
      // Reconstruct path
      const path: Position[] = [];
      let pos: Position | undefined = current;
      while (pos) {
        path.unshift(pos);
        pos = parent.get(key(pos.x, pos.y));
      }
      return path;
    }

    for (const [dx, dy] of dirs) {
      const nx = current.x + dx;
      const ny = current.y + dy;
      const nKey = key(nx, ny);

      if (
        inBounds(grid, nx, ny) &&
        !visited.has(nKey) &&
        options.walkable(grid.cells[ny * grid.width + nx], { x: nx, y: ny })
      ) {
        visited.add(nKey);
        parent.set(nKey, current);
        queue.push({ x: nx, y: ny });
      }
    }
  }

  return null;
}

/**
 * Flood fill from a starting position.
 *
 * Fills all connected cells matching `match` with `fill`.
 *
 * @returns Number of cells filled.
 */
function floodFill<T>(grid: Grid<T>, x: number, y: number, options: FloodFillOptions<T>): number {
  if (!inBounds(grid, x, y)) return 0;
  if (grid.cells[y * grid.width + x] !== options.match) return 0;
  if (options.match === options.fill) return 0;

  let filled = 0;
  const queue: Position[] = [{ x, y }];
  const key = (px: number, py: number) => `${px},${py}`;
  const visited = new Set<string>();
  visited.add(key(x, y));

  const dirs: [number, number][] = [
    [0, -1],
    [0, 1],
    [-1, 0],
    [1, 0],
  ];

  while (queue.length > 0) {
    const pos = queue.shift();
    if (!pos) break;
    grid.cells[pos.y * grid.width + pos.x] = options.fill;
    filled++;

    for (const [dx, dy] of dirs) {
      const nx = pos.x + dx;
      const ny = pos.y + dy;
      const nKey = key(nx, ny);

      if (
        inBounds(grid, nx, ny) &&
        !visited.has(nKey) &&
        grid.cells[ny * grid.width + nx] === options.match
      ) {
        visited.add(nKey);
        queue.push({ x: nx, y: ny });
      }
    }
  }

  return filled;
}

/**
 * Clone a grid (deep copy of cells).
 */
function clone<T>(grid: Grid<T>): Grid<T> {
  return {
    width: grid.width,
    height: grid.height,
    cells: [...grid.cells],
  };
}

export const gridBoard = {
  create,
  get,
  set,
  inBounds,
  neighbors,
  findPath,
  floodFill,
  clone,
};
