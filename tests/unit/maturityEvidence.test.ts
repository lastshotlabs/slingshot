import { cpSync, mkdtempSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';
import { generateMaturityOutputs, repoRoot } from '../../scripts/generate-maturity-evidence';

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('maturity evidence generation', () => {
  test('is byte-for-byte deterministic and inventories every public package', async () => {
    const first = await generateMaturityOutputs();
    const second = await generateMaturityOutputs();
    expect(second).toEqual(first);
    const report = JSON.parse(first['artifacts/maturity/maturity.v1.json']!) as {
      packages: Array<{ passed: boolean }>;
    };
    expect(report.packages).toHaveLength(44);
    expect(report.packages.every(pkg => pkg.passed)).toBe(true);
  });

  test('fails when a required evidence artifact is deleted', async () => {
    const root = mkdtempSync(join(tmpdir(), 'slingshot-maturity-'));
    temporaryRoots.push(root);
    cpSync(join(repoRoot, 'package.json'), join(root, 'package.json'), { recursive: true });
    cpSync(join(repoRoot, 'package-maturity.json'), join(root, 'package-maturity.json'));
    cpSync(join(repoRoot, 'packages'), join(root, 'packages'), {
      recursive: true,
      filter: source => !source.includes('node_modules') && !source.includes('/dist'),
    });
    cpSync(join(repoRoot, 'artifacts'), join(root, 'artifacts'), { recursive: true });
    unlinkSync(join(root, 'artifacts/evidence/tenant.v1.json'));

    await expect(generateMaturityOutputs(root)).rejects.toThrow('Missing required artifact');
  });

  test('rejects an unsupported promotion before publish', async () => {
    const root = mkdtempSync(join(tmpdir(), 'slingshot-maturity-'));
    temporaryRoots.push(root);
    cpSync(join(repoRoot, 'package.json'), join(root, 'package.json'));
    cpSync(join(repoRoot, 'package-maturity.json'), join(root, 'package-maturity.json'));
    cpSync(join(repoRoot, 'packages'), join(root, 'packages'), {
      recursive: true,
      filter: source => !source.includes('node_modules') && !source.includes('/dist'),
    });
    cpSync(join(repoRoot, 'artifacts'), join(root, 'artifacts'), { recursive: true });
    const declaration = JSON.parse(await Bun.file(join(root, 'package-maturity.json')).text()) as {
      packages: Array<{ name: string; stability: string; distTag: string }>;
    };
    const auth = declaration.packages.find(pkg => pkg.name === '@lastshotlabs/slingshot-auth')!;
    auth.distTag = 'latest';
    await Bun.write(join(root, 'package-maturity.json'), JSON.stringify(declaration));

    await expect(generateMaturityOutputs(root)).rejects.toThrow('Unsupported promotion/dist-tag');
  });
});
