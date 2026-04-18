import { Args, Command } from '@oclif/core';
import { spawnSync } from 'child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { selectOption, textInput } from '../utils/tui';

function choose(question: string, options: string[], defaultIndex = 0): number {
  const chosen = selectOption(question, options, defaultIndex);
  return options.indexOf(chosen);
}

export default class Init extends Command {
  static override description = 'Scaffold a new Slingshot application';
  static override examples = [
    '<%= config.bin %> init my-app',
    '<%= config.bin %> init my-app ./apps/my-app',
  ];
  static override args = {
    name: Args.string({ description: 'App name' }),
    dir: Args.string({ description: 'Output directory' }),
  };

  async run(): Promise<void> {
    const { args } = await this.parse(Init);
    const argTitle = args.name;
    const argDir = args.dir;

    const appTitle = argTitle || textInput('App name');
    if (!appTitle) {
      console.error('App name is required.');
      process.exit(1);
    }

    const dirDefault = appTitle
      .toLowerCase()
      .replace(/\s+/g, '-')
      .replace(/[^a-z0-9-]/g, '');
    const dirName =
      argDir || (argTitle ? dirDefault : textInput('Directory', dirDefault)) || dirDefault;

    // --- database config ---
    type DbStore = 'redis' | 'mongo' | 'sqlite' | 'memory';

    let mongoMode: 'single' | 'separate' | false = false;
    let useRedis = false;
    let authStore: 'mongo' | 'sqlite' | 'memory' = 'mongo';
    let sessionStore: DbStore = 'redis';
    let cacheStore: DbStore = 'redis';
    let oauthStateStore: DbStore = 'redis';

    console.log('');

    const presetChoice = choose('Database setup:', [
      'Full stack        (MongoDB + Redis — production ready)',
      'SQLite            (single file, no external services)',
      'Memory            (ephemeral, great for prototyping/tests)',
      'Custom            (choose each store individually)',
    ]);

    if (presetChoice === 0) {
      // Full stack
      const mongoChoice = choose('MongoDB connection mode:', [
        'Single   (auth + app data share one connection)',
        'Separate (auth on its own cluster)',
      ]);
      mongoMode = mongoChoice === 0 ? 'single' : 'separate';
      useRedis = true;
      authStore = 'mongo';
      sessionStore = 'redis';
      cacheStore = 'redis';
      oauthStateStore = 'redis';
    } else if (presetChoice === 1) {
      // SQLite
      mongoMode = false;
      useRedis = false;
      authStore = 'sqlite';
      sessionStore = 'sqlite';
      cacheStore = 'sqlite';
      oauthStateStore = 'sqlite';
    } else if (presetChoice === 2) {
      // Memory
      mongoMode = false;
      useRedis = false;
      authStore = 'memory';
      sessionStore = 'memory';
      cacheStore = 'memory';
      oauthStateStore = 'memory';
    } else {
      // Custom — prompt each store individually
      console.log('\n  Configure each store:\n');

      // MongoDB
      const mongoChoice = choose('MongoDB:', [
        'Single   (one connection for auth + app data)',
        'Separate (auth on its own cluster)',
        'None     (no MongoDB)',
      ]);
      if (mongoChoice === 0) mongoMode = 'single';
      else if (mongoChoice === 1) mongoMode = 'separate';
      else mongoMode = false;

      // Redis
      const redisChoice = choose('Redis:', ['Yes', 'No']);
      useRedis = redisChoice === 0;

      // Build available store options based on what's enabled
      const storeOptions: DbStore[] = [];
      const storeLabels: string[] = [];
      if (useRedis) {
        storeOptions.push('redis');
        storeLabels.push('Redis');
      }
      if (mongoMode) {
        storeOptions.push('mongo');
        storeLabels.push('MongoDB');
      }
      storeOptions.push('sqlite', 'memory');
      storeLabels.push('SQLite', 'Memory');

      // Auth store (no redis option)
      const authOptions: ('mongo' | 'sqlite' | 'memory')[] = [];
      const authLabels: string[] = [];
      if (mongoMode) {
        authOptions.push('mongo');
        authLabels.push('MongoDB');
      }
      authOptions.push('sqlite', 'memory');
      authLabels.push('SQLite', 'Memory');

      const authChoice = choose('Auth store:', authLabels);
      authStore = authOptions[authChoice] ?? 'memory';

      const sessChoice = choose('Sessions store:', storeLabels);
      sessionStore = storeOptions[sessChoice] ?? 'redis';

      const cacheChoice = choose('Cache store:', storeLabels);
      cacheStore = storeOptions[cacheChoice] ?? 'redis';

      const oauthChoice = choose('OAuth state store:', storeLabels);
      oauthStateStore = storeOptions[oauthChoice] ?? 'redis';
    }

    // If any store uses sqlite, we need the sqlite path
    const usesSqlite =
      authStore === 'sqlite' ||
      sessionStore === 'sqlite' ||
      cacheStore === 'sqlite' ||
      oauthStateStore === 'sqlite';

    // --- auth config ---
    console.log('');

    type AuthPosture = 'web-saas' | 'internal' | 'mobile-api' | 'dev' | 'custom';
    let authPosture: AuthPosture = 'web-saas';

    interface StepByStepChoices {
      passwordPolicy: 'relaxed' | 'strong' | 'minimal';
      emailVerification: boolean;
      passwordReset: boolean;
      refreshTokens: boolean;
      mfa: 'none' | 'optional' | 'required';
      csrf: boolean;
      oauthProviders: string[];
    }
    let stepByStep: StepByStepChoices | null = null;

    const authConfigMode = choose('How would you like to configure auth?', [
      'Use a preset     (pick a security posture, get sensible defaults)',
      'Step by step     (choose features individually)',
    ]);

    if (authConfigMode === 0) {
      // Preset path
      const presetIndex = choose('Which best describes your app?', [
        `Web app / SaaS       (CSRF, refresh tokens, botProtection)`,
        `Internal / admin     (MFA required, no refresh tokens, tight limits)`,
        `Mobile / API only    (no CSRF, cors: "*", header auth)`,
        `Dev / prototype      (permissive — iterate fast, no rate limits)`,
      ]);
      const presets: AuthPosture[] = ['web-saas', 'internal', 'mobile-api', 'dev'];
      authPosture = presets[presetIndex];
    } else {
      // Step-by-step path
      authPosture = 'custom';

      const pwPolicyIndex = choose('Password policy:', [
        'Relaxed (8 chars)',
        'Strong (12+ chars, special required)',
        'Minimal (dev only)',
      ]);
      const passwordPolicy =
        (['relaxed', 'strong', 'minimal'] as const)[pwPolicyIndex] ?? 'relaxed';

      const emailVerifIndex = choose('Email verification:', ['Yes', 'No']);
      const emailVerification = emailVerifIndex === 0;

      const pwResetIndex = choose('Password reset:', ['Yes', 'No']);
      const passwordReset = pwResetIndex === 0;

      const refreshIndex = choose('Refresh tokens:', ['Yes', 'No']);
      const refreshTokens = refreshIndex === 0;

      const mfaIndex = choose('MFA:', ['None', 'Optional (users opt in)', 'Required (all users)']);
      const mfa = (['none', 'optional', 'required'] as const)[mfaIndex];

      const csrfIndex = choose('CSRF protection:', ['Yes', 'No']);
      const csrf = csrfIndex === 0;

      const oauthProviders: string[] = [];
      const allProviders = ['Google', 'GitHub', 'Apple', 'Microsoft'];
      for (;;) {
        const remaining = [...allProviders.filter(p => !oauthProviders.includes(p)), 'None (done)'];
        const pIdx = choose('OAuth providers (select all that apply):', remaining);
        const picked = remaining[pIdx];
        if (picked === 'None (done)') break;
        oauthProviders.push(picked);
      }

      stepByStep = {
        passwordPolicy,
        emailVerification,
        passwordReset,
        refreshTokens,
        mfa,
        csrf,
        oauthProviders,
      };
    }

    // --- paths ---
    const projectDir = join(process.cwd(), dirName);
    const srcDir = join(projectDir, 'src');
    const configDir = join(srcDir, 'config');
    const libDir = join(srcDir, 'lib');
    const routesDir = join(srcDir, 'routes');
    const workersDir = join(srcDir, 'workers');
    const queuesDir = join(srcDir, 'queues');
    const wsDir = join(srcDir, 'ws');
    const servicesDir = join(srcDir, 'services');
    const middlewareDir = join(srcDir, 'middleware');
    const modelsDir = join(srcDir, 'models');

    if (existsSync(projectDir)) {
      console.error(`Directory "${dirName}" already exists.`);
      process.exit(1);
    }

    // --- build db config string ---
    function buildDbConfig(): string {
      const lines: string[] = [];

      if (mongoMode) {
        lines.push(`  mongo: "${mongoMode}",`);
      } else {
        lines.push(`  mongo: false,`);
      }

      lines.push(`  redis: ${useRedis},`);
      lines.push(`  auth: "${authStore}",`);
      lines.push(`  sessions: "${sessionStore}",`);
      lines.push(`  oauthState: "${oauthStateStore}",`);
      lines.push(`  cache: "${cacheStore}",`);

      if (usesSqlite) {
        lines.push(`  sqlite: path.join(import.meta.dir, "../../data.db"),`);
      }

      return `{\n${lines.join('\n')}\n}`;
    }

    // --- build auth + security config string ---
    function buildAuthSecurityConfig(): string {
      if (authPosture === 'web-saas') {
        return `export const auth: AuthConfig = {
  roles: Object.values(USER_ROLES),
  defaultRole: USER_ROLES.USER,
  passwordPolicy: { minLength: 8, requireLetter: true, requireDigit: true },
  // Uncomment to require email verification before login:
  // emailVerification: {
  //   required: true,
  //   // Listen to auth:delivery.email_verification bus event to send the email
  // },
  // Uncomment to enable password reset:
  // passwordReset: {
  //   // Listen to auth:delivery.password_reset bus event to send the reset email
  // },
  refreshTokens: { accessTokenExpiry: 900, refreshTokenExpiry: 2_592_000 },
  sessionPolicy: { trackLastActive: true },
  // Uncomment to enable opt-in MFA (TOTP + email OTP):
  // mfa: { issuer: APP_NAME },
};

export const security: SecurityConfig = {
  cors: ["https://myapp.com"],   // TODO: replace with your domain
  trustProxy: 1,
  csrf: { enabled: true },
  botProtection: { fingerprintRateLimit: true },
};`;
      }

      if (authPosture === 'internal') {
        return `export const auth: AuthConfig = {
  roles: ["superadmin", "admin", "viewer"],
  defaultRole: "viewer",
  passwordPolicy: { minLength: 14, requireLetter: true, requireDigit: true, requireSpecial: true },
  mfa: { issuer: APP_NAME, required: true },
  sessionPolicy: {
    maxSessions: 2,
    trackLastActive: true,
    persistSessionMetadata: true,
    includeInactiveSessions: true,
  },
  rateLimit: { login: { windowMs: 15 * 60 * 1000, max: 5 } },
};

export const security: SecurityConfig = {
  cors: ["https://admin.myapp.com"],  // TODO: replace with your domain
  trustProxy: 1,
  csrf: { enabled: true },
  rateLimit: { windowMs: 60_000, max: 30 },
};`;
      }

      if (authPosture === 'mobile-api') {
        return `export const auth: AuthConfig = {
  roles: Object.values(USER_ROLES),
  defaultRole: USER_ROLES.USER,
  refreshTokens: { accessTokenExpiry: 900, refreshTokenExpiry: 2_592_000, rotationGraceSeconds: 60 },
  sessionPolicy: { maxSessions: 5 },
};

export const security: SecurityConfig = {
  cors: "*",
  trustProxy: 1,
  botProtection: { fingerprintRateLimit: true },
};`;
      }

      if (authPosture === 'dev') {
        return `export const auth: AuthConfig = {
  roles: Object.values(USER_ROLES),
  defaultRole: USER_ROLES.USER,
  passwordPolicy: { minLength: 1, requireLetter: false, requireDigit: false, requireSpecial: false },
  rateLimit: {
    login: { windowMs: 60_000, max: 10_000 },
    register: { windowMs: 60_000, max: 10_000 },
  },
};

export const security: SecurityConfig = {
  cors: "*",
  bearerAuth: false,
};`;
      }

      // Custom / step-by-step
      if (!stepByStep) throw new Error('Internal error: custom auth configuration not completed');
      const c = stepByStep;
      const authLines: string[] = [
        `  roles: Object.values(USER_ROLES),`,
        `  defaultRole: USER_ROLES.USER,`,
      ];

      if (c.passwordPolicy === 'relaxed') {
        authLines.push(
          `  passwordPolicy: { minLength: 8, requireLetter: true, requireDigit: true },`,
        );
      } else if (c.passwordPolicy === 'strong') {
        authLines.push(
          `  passwordPolicy: { minLength: 12, requireLetter: true, requireDigit: true, requireSpecial: true },`,
        );
      } else {
        authLines.push(
          `  passwordPolicy: { minLength: 1, requireLetter: false, requireDigit: false, requireSpecial: false },`,
        );
      }

      if (c.emailVerification) {
        authLines.push(`  emailVerification: {`);
        authLines.push(`    required: true,`);
        authLines.push(
          `    // Listen to auth:delivery.email_verification bus event to send the email`,
        );
        authLines.push(`  },`);
      }

      if (c.passwordReset) {
        authLines.push(`  passwordReset: {`);
        authLines.push(
          `    // Listen to auth:delivery.password_reset bus event to send the reset email`,
        );
        authLines.push(`  },`);
      }

      if (c.refreshTokens) {
        authLines.push(
          `  refreshTokens: { accessTokenExpiry: 900, refreshTokenExpiry: 2_592_000 },`,
        );
      }

      if (c.mfa === 'optional') {
        authLines.push(`  mfa: { issuer: APP_NAME },`);
      } else if (c.mfa === 'required') {
        authLines.push(`  mfa: { issuer: APP_NAME, required: true },`);
      }

      authLines.push(`  sessionPolicy: { trackLastActive: true },`);

      const authBlock = `export const auth: AuthConfig = {\n${authLines.join('\n')}\n};`;

      const secLines: string[] = [`  cors: "*",`];
      if (c.csrf) {
        secLines.push(`  csrf: { enabled: true },`);
      }
      const secBlock = `export const security: SecurityConfig = {\n${secLines.join('\n')}\n};`;

      return `${authBlock}\n\n${secBlock}`;
    }

    // --- templates ---
    const constantsContent = `export const APP_NAME = "${appTitle}";
export const APP_VERSION = "1.0.0";

export const USER_ROLES = {
  ADMIN: "admin",
  USER: "user",
};
`;

    const configContent = `import path from "path";
import {
  type AppMeta,
  type AuthConfig,
  type CreateServerConfig,
  type DbConfig,
  type SecurityConfig,
} from "@lastshotlabs/slingshot";
import { APP_NAME, APP_VERSION, USER_ROLES } from "@shared/constants";

export const app: AppMeta = {
  name: APP_NAME,
  version: APP_VERSION,
};

export const routesDir = path.join(import.meta.dir, "../routes");

export const workersDir = path.join(import.meta.dir, "../workers");

export const port = process.env.PORT ? parseInt(process.env.PORT) : 3000;

export const db: DbConfig = ${buildDbConfig()};

${buildAuthSecurityConfig()}

export const appConfig: CreateServerConfig = {
  app,
  routesDir,
  workersDir,
  port,
  db,
  auth,
  security,
};
`;

    const indexContent = `import { createServer } from "@lastshotlabs/slingshot";
import { appConfig } from "@config/index";

await createServer(appConfig);
`;

    const readmeContent = `# ${appTitle}

Built with [@lastshotlabs/slingshot](https://github.com/Last-Shot-Labs/slingshot).

## Getting started

\`\`\`bash
# fill in .env with your values
bun dev
\`\`\`

| Endpoint | Description |
|---|---|
| \`POST /auth/register\` | Create account |
| \`POST /auth/login\` | Sign in, returns JWT |
| \`GET  /docs\` | OpenAPI docs (Scalar) |
| \`GET  /health\` | Health check |

## Project structure

\`\`\`
src/
  index.ts          # server entry point
  config/index.ts   # centralized app configuration
  lib/constants.ts  # app name, version, roles
  routes/           # file-based routing (each file = a router)
  workers/          # BullMQ workers (auto-imported on start)
  middleware/       # custom middleware
  models/           # data models
  services/         # business logic
\`\`\`

## Adding routes

Create a file in \`src/routes/\`:

\`\`\`ts
// src/routes/products.ts
import { createRouter } from "@lastshotlabs/slingshot";
import { z } from "zod";

export const router = createRouter();

router.get("/products", (c) => c.json({ products: [] }));
\`\`\`
${
  mongoMode
    ? `
## Adding models

\`\`\`ts
// src/models/Product.ts
import { getMongooseModule, getMongoFromApp } from "@lastshotlabs/slingshot";

const mongoose = getMongooseModule();

const ProductSchema = new mongoose.Schema({
  name: { type: String, required: true },
  price: { type: Number, required: true },
}, { timestamps: true });

// Use getMongoFromApp(app) to get connections from context
// export const Product = appConn.model("Product", ProductSchema);
\`\`\`
`
    : ''
}
## Environment variables

See \`.env\` — fill in the values before running.
`;

    // --- build .env based on choices ---
    function buildEnv(): string {
      const sections: string[] = [`NODE_ENV=development`, `PORT=3000`];

      if (mongoMode === 'single') {
        sections.push(`
# MongoDB
MONGO_USER=
MONGO_PASSWORD=
MONGO_HOST=
MONGO_DB=`);
      } else if (mongoMode === 'separate') {
        sections.push(`
# MongoDB (app data)
MONGO_USER=
MONGO_PASSWORD=
MONGO_HOST=
MONGO_DB=

# MongoDB (auth — separate cluster)
MONGO_AUTH_USER=
MONGO_AUTH_PASSWORD=
MONGO_AUTH_HOST=
MONGO_AUTH_DB=`);
      }

      if (useRedis) {
        sections.push(`
# Redis
REDIS_HOST=
REDIS_USER=
REDIS_PASSWORD=`);
      }

      sections.push(`
# JWT
JWT_SECRET=

# Bearer API key
BEARER_TOKEN=

# OAuth — Google (optional)
# GOOGLE_CLIENT_ID=
# GOOGLE_CLIENT_SECRET=
# GOOGLE_REDIRECT_URI=

# OAuth — Apple (optional)
# APPLE_CLIENT_ID=
# APPLE_TEAM_ID=
# APPLE_KEY_ID=
# APPLE_PRIVATE_KEY=
# APPLE_REDIRECT_URI=

# OAuth — GitHub (optional)
# GITHUB_CLIENT_ID=
# GITHUB_CLIENT_SECRET=
# GITHUB_REDIRECT_URI=

# OAuth — Microsoft (optional)
# MICROSOFT_TENANT_ID=
# MICROSOFT_CLIENT_ID=
# MICROSOFT_CLIENT_SECRET=
# MICROSOFT_REDIRECT_URI=`);

      return sections.join('\n') + '\n';
    }

    // --- scaffold ---
    console.log(`\n@lastshotlabs/slingshot — creating ${dirName}\n`);

    mkdirSync(projectDir, { recursive: true });

    // bun init -y (handles package.json, tsconfig.json, .gitignore)
    console.log('  Running bun init...');
    spawnSync('bun', ['init', '-y'], { cwd: projectDir, stdio: 'inherit' });

    // Remove the root index.ts bun init creates — we use src/index.ts
    const rootIndex = join(projectDir, 'index.ts');
    if (existsSync(rootIndex)) rmSync(rootIndex);

    // Patch package.json: add dependency + fix scripts + module entry
    interface PkgJson {
      module?: string;
      scripts?: Record<string, string>;
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    }
    const pkgPath = join(projectDir, 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as PkgJson;
    pkg.module = 'src/index.ts';
    pkg.scripts = { dev: 'bun --watch src/index.ts', start: 'bun src/index.ts' };
    pkg.dependencies = { ...pkg.dependencies, '@lastshotlabs/slingshot': '*' };
    pkg.devDependencies = { ...pkg.devDependencies, '@lastshotlabs/slingshot-infra': '*' };
    writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf-8');

    // Write tsconfig.json with full compiler options and path aliases
    const tsconfigPath = join(projectDir, 'tsconfig.json');
    const tsconfigContent = {
      compilerOptions: {
        lib: ['ESNext'],
        target: 'ESNext',
        module: 'Preserve',
        moduleDetection: 'force',
        jsx: 'react-jsx',
        allowJs: true,
        moduleResolution: 'bundler',
        allowImportingTsExtensions: true,
        verbatimModuleSyntax: true,
        noEmit: true,
        strict: true,
        skipLibCheck: true,
        noFallthroughCasesInSwitch: true,
        noUncheckedIndexedAccess: true,
        noImplicitOverride: true,
        noUnusedLocals: false,
        noUnusedParameters: false,
        noPropertyAccessFromIndexSignature: false,
        paths: {
          '@lib/*': ['./src/lib/*'],
          '@middleware/*': ['./src/middleware/*'],
          '@models/*': ['./src/models/*'],
          '@queues/*': ['./src/queues/*'],
          '@routes/*': ['./src/routes/*'],
          '@scripts/*': ['./src/scripts/*'],
          '@services/*': ['./src/services/*'],
          '@workers/*': ['./src/workers/*'],
          '@service-facades/*': ['./src/service-facades/*'],
          '@config/*': ['./src/config/*'],
          '@constants/*': ['./src/lib/constants/*'],
        },
      },
    };
    writeFileSync(tsconfigPath, JSON.stringify(tsconfigContent, null, 2) + '\n', 'utf-8');

    // Create src structure
    mkdirSync(configDir, { recursive: true });
    mkdirSync(libDir, { recursive: true });
    mkdirSync(routesDir, { recursive: true });
    mkdirSync(workersDir, { recursive: true });
    mkdirSync(queuesDir, { recursive: true });
    mkdirSync(wsDir, { recursive: true });
    mkdirSync(servicesDir, { recursive: true });
    mkdirSync(middlewareDir, { recursive: true });
    mkdirSync(modelsDir, { recursive: true });
    writeFileSync(join(libDir, 'constants.ts'), constantsContent, 'utf-8');
    writeFileSync(join(configDir, 'index.ts'), configContent, 'utf-8');
    writeFileSync(join(srcDir, 'index.ts'), indexContent, 'utf-8');
    writeFileSync(join(projectDir, '.env'), buildEnv(), 'utf-8');
    writeFileSync(join(projectDir, 'README.md'), readmeContent, 'utf-8');

    // --- summary ---
    console.log('  Created:');
    console.log(`    + ${dirName}/src/index.ts`);
    console.log(`    + ${dirName}/src/config/index.ts`);
    console.log(`    + ${dirName}/src/lib/constants.ts`);
    console.log(`    + ${dirName}/src/routes/`);
    console.log(`    + ${dirName}/src/workers/`);
    console.log(`    + ${dirName}/src/queues/`);
    console.log(`    + ${dirName}/src/ws/`);
    console.log(`    + ${dirName}/src/services/`);
    console.log(`    + ${dirName}/src/middleware/`);
    console.log(`    + ${dirName}/src/models/`);
    console.log(`    + ${dirName}/.env`);
    console.log(`    + ${dirName}/README.md`);

    console.log(`\n  DB config:`);
    console.log(`    mongo: ${mongoMode || 'none'} | redis: ${useRedis}`);
    console.log(
      `    auth: ${authStore} | sessions: ${sessionStore} | cache: ${cacheStore} | oauthState: ${oauthStateStore}`,
    );

    console.log(`\n  Auth config:`);
    console.log(`    posture: ${authPosture}`);

    // --- git init ---
    console.log('\n  Initializing git...');
    const git = spawnSync('git', ['init'], { cwd: projectDir, stdio: 'inherit' });
    if (git.status !== 0) {
      console.error('  git init failed — skipping.');
    }

    // --- bun install ---
    console.log('\n  Installing dependencies...');
    const install = spawnSync('bun', ['install'], { cwd: projectDir, stdio: 'inherit' });
    if (install.status !== 0) {
      console.error('\n  bun install failed. Run it manually inside the directory.');
      process.exit(1);
    }

    // --- optional infra scaffolding ---
    {
      const setupInfra = selectOption('Set up deployment infrastructure?', ['Yes', 'No'], 1);

      if (setupInfra === 'Yes') {
        try {
          const { generatePlatformTemplate, generateInfraTemplate } =
            await import('@lastshotlabs/slingshot-infra');

          const platformTemplate = generatePlatformTemplate({
            org: dirName,
            region: 'us-east-1',
            preset: 'ecs',
          });
          writeFileSync(join(projectDir, 'slingshot.platform.ts'), platformTemplate, 'utf-8');
          console.log('  Created slingshot.platform.ts');

          const infraTemplate = generateInfraTemplate({
            stacks: ['main'],
            port: 3000,
          });
          writeFileSync(join(projectDir, 'slingshot.infra.ts'), infraTemplate, 'utf-8');
          console.log('  Created slingshot.infra.ts');
        } catch {
          console.log(
            '  slingshot-infra not installed — skipping. Install with: bun add -d @lastshotlabs/slingshot-infra',
          );
        }
      }
    }

    console.log(`\nDone! Next steps:\n`);
    console.log(`  cd ${dirName}`);
    console.log(`  # fill in .env`);
    console.log(`  bun dev\n`);
  }
}
