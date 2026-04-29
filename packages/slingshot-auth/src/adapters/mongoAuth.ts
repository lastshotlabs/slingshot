import { createAuthUserModel } from '@auth/models/AuthUser';
import { createGroupModel } from '@auth/models/Group';
import { createGroupMembershipModel } from '@auth/models/GroupMembership';
import { createM2MClientModel } from '@auth/models/M2MClient';
import type { IM2MClient } from '@auth/models/M2MClient';
import { createTenantRoleModel } from '@auth/models/TenantRole';
import type {
  AuthAdapter,
  GroupRecord,
  IdentityProfile,
  RuntimePassword,
  UserQuery,
  UserRecord,
} from '@lastshotlabs/slingshot-core';
import { HttpError, decodeCursor, encodeCursor } from '@lastshotlabs/slingshot-core';
import { normalizeEmail } from '../lib/normalizeEmail';

/** Shape of a user document returned by Mongoose `.lean()`. */
interface MongoUserDoc {
  _id: unknown;
  password?: string;
  passwordHash?: string;
  identifier?: string;
  email?: string;
  displayName?: string;
  firstName?: string;
  lastName?: string;
  externalId?: string;
  suspended?: boolean;
  suspendedReason?: string;
  userMetadata?: Record<string, unknown>;
  appMetadata?: Record<string, unknown>;
  mfaEnabled?: boolean;
  mfaMethods?: string[];
  mfaSecret?: string;
  recoveryCodes?: string[];
  webauthnCredentials?: Array<{
    credentialId: string;
    publicKey: string;
    signCount: number;
    transports?: string[];
    name?: string;
    createdAt: Date | number;
  }>;
  passwordHistory?: string[];
  roles?: string[];
  providerIds?: string[];
  emailVerified?: boolean;
  suspendedAt?: Date | string | null;
}

/** Shape of a group document returned by Mongoose `.lean()`. */
interface MongoGroupDoc {
  _id: unknown;
  name: string;
  displayName?: string;
  description?: string;
  roles?: string[];
  tenantId?: string | null;
  createdAt: Date | number;
  updatedAt: Date | number;
}

/** Shape of a group membership document returned by Mongoose `.lean()`. */
interface MongoGroupMembershipDoc {
  _id: unknown;
  groupId: string;
  userId: string;
  roles?: string[];
  tenantId?: string | null;
  createdAt?: Date;
}

interface MongoCursorPayload {
  createdAt: number;
  id: string;
}

function mongoGroupToRecord(doc: MongoGroupDoc): GroupRecord {
  return {
    id: String(doc._id),
    name: doc.name,
    displayName: doc.displayName,
    description: doc.description,
    roles: doc.roles ?? [],
    tenantId: doc.tenantId ?? null,
    createdAt: doc.createdAt instanceof Date ? doc.createdAt.getTime() : doc.createdAt,
    updatedAt: doc.updatedAt instanceof Date ? doc.updatedAt.getTime() : doc.updatedAt,
  };
}

function isMongoDuplicateKeyError(err: unknown): boolean {
  return (err as { code?: unknown }).code === 11000;
}

function createIndexEnsurer(
  models: Array<{ createIndexes(): Promise<unknown> }>,
): () => Promise<void> {
  let pending: Promise<void> | null = null;
  return async () => {
    pending ??= Promise.all(models.map(model => model.createIndexes()))
      .then(() => undefined)
      .catch((err: unknown) => {
        pending = null;
        throw err;
      });
    await pending;
  };
}

/**
 * Creates a MongoDB-backed `AuthAdapter` using Mongoose.
 *
 * Manages users, roles, groups, group memberships, M2M clients, and tenant roles in
 * separate collections on the provided connection. All models are registered on `conn`
 * only — the global `mongoose.models` registry is not touched.
 *
 * @param conn - A Mongoose `Connection` for the auth database.
 * @param mg - The `mongoose` module. Passed explicitly to avoid optional-dep resolution issues.
 * @param passwordRuntime - Optional password hashing runtime. Required when this adapter
 *   is used standalone (without the framework providing a `RuntimePassword` from config).
 * @returns A fully-featured `AuthAdapter` backed by MongoDB.
 *
 * @example
 * import { createMongoAuthAdapter } from '@lastshotlabs/slingshot-auth';
 * import mongoose from 'mongoose';
 *
 * const conn = await mongoose.createConnection(process.env.MONGO_AUTH_URI!).asPromise();
 * const adapter = createMongoAuthAdapter(conn, mongoose);
 *
 * @remarks
 * Requires `mongoose` peer dependency (>=9.0). Not supported in the Bun SQLite-only bundle.
 */
export function createMongoAuthAdapter(
  conn: import('mongoose').Connection,
  mg: typeof import('mongoose'),
  passwordRuntime?: RuntimePassword,
): AuthAdapter {
  const AuthUser = createAuthUserModel(conn, mg);
  const TenantRole = createTenantRoleModel(conn, mg);
  const Group = createGroupModel(conn, mg);
  const GroupMembership = createGroupMembershipModel(conn, mg);
  const M2MClient = createM2MClientModel(conn, mg);
  const ensureIndexes = createIndexEnsurer([
    AuthUser,
    TenantRole,
    Group,
    GroupMembership,
    M2MClient,
  ]);

  const adapter: AuthAdapter & { ready(): Promise<void> } = {
    ready: ensureIndexes,
    async findByEmail(email) {
      const user = await AuthUser.findOne({ email: normalizeEmail(email) });
      if (!user) return null;
      return { id: String(user._id), passwordHash: user.password as string };
    },
    async create(email, passwordHash) {
      try {
        await ensureIndexes();
        const normalized = normalizeEmail(email);
        const user = await AuthUser.create({
          email: normalized,
          identifier: normalized,
          password: passwordHash,
        });
        return { id: String(user._id) };
      } catch (err: unknown) {
        if ((err as { code?: unknown }).code === 11000)
          throw new HttpError(409, 'Email already registered');
        throw err;
      }
    },
    async verifyPassword(userId, password) {
      const user = (await AuthUser.findById(userId)
        .select('password')
        .lean()) as MongoUserDoc | null;
      if (!user?.password) return false;
      if (passwordRuntime) return passwordRuntime.verify(password, user.password);
      return Bun.password.verify(password, user.password);
    },
    async getIdentifier(userId) {
      const user = (await AuthUser.findById(userId)
        .select('identifier email')
        .lean()) as MongoUserDoc | null;
      return user?.identifier ?? user?.email ?? '';
    },
    async setPassword(userId, passwordHash) {
      await AuthUser.findByIdAndUpdate(userId, { password: passwordHash });
    },
    async findOrCreateByProvider(provider, providerId, profile) {
      const key = `${provider}:${providerId}`;

      let user = await AuthUser.findOne({ providerIds: key });
      if (user) return { id: String(user._id), created: false };

      if (profile.email) {
        const existing = await AuthUser.findOne({ email: normalizeEmail(profile.email) });
        if (existing)
          throw new HttpError(
            409,
            'An account with this email already exists. Sign in with your credentials, then link Google from your account settings.',
          );
      }

      const normalizedEmail = profile.email ? normalizeEmail(profile.email) : undefined;
      try {
        await ensureIndexes();
        user = await AuthUser.create({
          email: normalizedEmail,
          identifier: normalizedEmail,
          providerIds: [key],
        });
      } catch (err: unknown) {
        if (isMongoDuplicateKeyError(err)) {
          const owner = await AuthUser.findOne({ providerIds: key }, '_id').lean();
          if (owner) return { id: String(owner._id), created: false };
        }
        throw err;
      }
      return { id: String(user._id), created: true };
    },
    async linkProvider(userId, provider, providerId) {
      const key = `${provider}:${providerId}`;
      const user = await AuthUser.findById(userId);
      if (!user) throw new HttpError(404, 'User not found');
      const existingOwner = await AuthUser.findOne({ providerIds: key }, '_id').lean();
      if (existingOwner && String(existingOwner._id) !== userId) {
        throw new HttpError(
          409,
          'This provider account is already linked to another user. Unlink it there before linking it here.',
        );
      }
      const providerIds = user.providerIds ?? [];
      if (!providerIds.includes(key)) {
        user.providerIds = [...providerIds, key];
        try {
          await ensureIndexes();
          await user.save();
        } catch (err: unknown) {
          if (isMongoDuplicateKeyError(err)) {
            throw new HttpError(
              409,
              'This provider account is already linked to another user. Unlink it there before linking it here.',
            );
          }
          throw err;
        }
      }
    },
    async getRoles(userId) {
      const user = await AuthUser.findById(userId, 'roles').lean();
      return user?.roles ?? [];
    },
    async setRoles(userId, roles) {
      await AuthUser.findByIdAndUpdate(userId, { roles });
    },
    async addRole(userId, role) {
      await AuthUser.findByIdAndUpdate(userId, { $addToSet: { roles: role } });
    },
    async removeRole(userId, role) {
      await AuthUser.findByIdAndUpdate(userId, { $pull: { roles: role } });
    },
    async getUser(userId) {
      const user = (await AuthUser.findById(
        userId,
        'email providerIds emailVerified displayName firstName lastName externalId suspended suspendedReason userMetadata appMetadata',
      ).lean()) as MongoUserDoc | null;
      if (!user) return null;
      return {
        id: String(user._id),
        email: user.email,
        providerIds: user.providerIds,
        emailVerified: user.emailVerified ?? false,
        displayName: user.displayName,
        firstName: user.firstName,
        lastName: user.lastName,
        externalId: user.externalId,
        suspended: user.suspended ?? false,
        suspendedReason: user.suspendedReason,
        userMetadata: user.userMetadata,
        appMetadata: user.appMetadata,
      };
    },
    async unlinkProvider(userId, provider) {
      const user = await AuthUser.findById(userId);
      if (!user) throw new HttpError(404, 'User not found');
      user.providerIds = (user.providerIds ?? []).filter(id => !id.startsWith(`${provider}:`));
      await user.save();
    },
    async findByIdentifier(identifier) {
      const normalized = normalizeEmail(identifier);
      const user = await AuthUser.findOne({
        $or: [{ identifier: normalized }, { email: normalized }],
      })
        .select('_id password')
        .lean();
      if (!user) return null;
      return { id: String(user._id), passwordHash: (user as MongoUserDoc).password ?? '' };
    },
    async setEmailVerified(userId, verified) {
      await AuthUser.findByIdAndUpdate(userId, { emailVerified: verified });
    },
    async getEmailVerified(userId) {
      const user = await AuthUser.findById(userId, 'emailVerified').lean();
      return user?.emailVerified ?? false;
    },
    async deleteUser(userId) {
      await AuthUser.findByIdAndDelete(userId);
      await TenantRole.deleteMany({ userId });
      await GroupMembership.deleteMany({ userId });
    },
    async hasPassword(userId) {
      const user = await AuthUser.findById(userId, 'password').lean();
      return !!user?.password;
    },
    async setMfaSecret(userId, secret) {
      await AuthUser.findByIdAndUpdate(userId, { mfaSecret: secret });
    },
    async getMfaSecret(userId) {
      const user = await AuthUser.findById(userId, 'mfaSecret').lean();
      return (user?.mfaSecret as string | undefined) ?? null;
    },
    async isMfaEnabled(userId) {
      const user = await AuthUser.findById(userId, 'mfaEnabled').lean();
      return user?.mfaEnabled ?? false;
    },
    async setMfaEnabled(userId, enabled) {
      await AuthUser.findByIdAndUpdate(userId, { mfaEnabled: enabled });
    },
    async setRecoveryCodes(userId, codes) {
      await AuthUser.findByIdAndUpdate(userId, { recoveryCodes: codes });
    },
    async getRecoveryCodes(userId) {
      const user = await AuthUser.findById(userId, 'recoveryCodes').lean();
      return user?.recoveryCodes ?? [];
    },
    async removeRecoveryCode(userId, code) {
      await AuthUser.findByIdAndUpdate(userId, { $pull: { recoveryCodes: code } });
    },
    async consumeRecoveryCode(userId, hashedCode) {
      const result = await AuthUser.findOneAndUpdate(
        { _id: userId, recoveryCodes: hashedCode },
        { $pull: { recoveryCodes: hashedCode } },
        { new: false },
      ).lean();
      return result !== null;
    },
    async getMfaMethods(userId) {
      const user = (await AuthUser.findById(
        userId,
        'mfaMethods mfaEnabled',
      ).lean()) as MongoUserDoc | null;
      if (!user) return [];
      if (user.mfaMethods && user.mfaMethods.length > 0) return user.mfaMethods;
      if (user.mfaEnabled) return ['totp'];
      return [];
    },
    async setMfaMethods(userId, methods) {
      await AuthUser.findByIdAndUpdate(userId, { mfaMethods: methods });
    },
    async getWebAuthnCredentials(userId) {
      const user = (await AuthUser.findById(
        userId,
        'webauthnCredentials',
      ).lean()) as MongoUserDoc | null;
      const creds = user?.webauthnCredentials ?? [];
      return creds.map(c => ({
        credentialId: c.credentialId,
        publicKey: c.publicKey,
        signCount: c.signCount,
        transports: c.transports,
        name: c.name,
        createdAt: c.createdAt instanceof Date ? c.createdAt.getTime() : c.createdAt,
      }));
    },
    async addWebAuthnCredential(userId, credential) {
      await AuthUser.findByIdAndUpdate(userId, {
        $push: {
          webauthnCredentials: {
            credentialId: credential.credentialId,
            publicKey: credential.publicKey,
            signCount: credential.signCount,
            transports: credential.transports,
            name: credential.name,
            createdAt: new Date(credential.createdAt),
          },
        },
      });
    },
    async removeWebAuthnCredential(userId, credentialId) {
      await AuthUser.findByIdAndUpdate(userId, {
        $pull: { webauthnCredentials: { credentialId } },
      });
    },
    async updateWebAuthnCredentialSignCount(userId, credentialId, signCount) {
      await AuthUser.findOneAndUpdate(
        { _id: userId, 'webauthnCredentials.credentialId': credentialId },
        { $set: { 'webauthnCredentials.$.signCount': signCount } },
      );
    },
    async findUserByWebAuthnCredentialId(credentialId) {
      const user = await AuthUser.findOne(
        { 'webauthnCredentials.credentialId': credentialId },
        '_id',
      ).lean();
      return user ? String(user._id) : null;
    },
    async getTenantRoles(userId, tenantId) {
      const doc = await TenantRole.findOne({ userId, tenantId }, 'roles').lean();
      return doc?.roles ?? [];
    },
    async setTenantRoles(userId, tenantId, roles) {
      await TenantRole.findOneAndUpdate(
        { userId, tenantId },
        { $set: { roles } },
        { upsert: true },
      );
    },
    async addTenantRole(userId, tenantId, role) {
      await TenantRole.findOneAndUpdate(
        { userId, tenantId },
        { $addToSet: { roles: role } },
        { upsert: true },
      );
    },
    async removeTenantRole(userId, tenantId, role) {
      await TenantRole.findOneAndUpdate({ userId, tenantId }, { $pull: { roles: role } });
    },

    async setSuspended(userId: string, suspended: boolean, reason?: string | null) {
      const update: Record<string, unknown> = { suspended };
      if (suspended) {
        update.suspendedAt = new Date();
        update.suspendedReason = reason ?? null;
      } else {
        update.suspendedAt = null;
        update.suspendedReason = null;
      }
      await AuthUser.updateOne({ _id: userId }, { $set: update });
    },

    async getSuspended(userId: string) {
      const user = (await AuthUser.findById(userId, {
        suspended: 1,
        suspendedReason: 1,
      }).lean()) as MongoUserDoc | null;
      if (!user) return null;
      return {
        suspended: user.suspended ?? false,
        suspendedReason: user.suspendedReason ?? undefined,
      };
    },

    async updateProfile(
      userId: string,
      fields: Partial<
        Pick<IdentityProfile, 'displayName' | 'firstName' | 'lastName' | 'externalId'> & {
          userMetadata?: Record<string, unknown>;
        }
      >,
    ) {
      await AuthUser.updateOne({ _id: userId }, { $set: fields });
    },

    async getUserMetadata(userId: string) {
      const user = (await AuthUser.findById(
        userId,
        'userMetadata appMetadata',
      ).lean()) as MongoUserDoc | null;
      if (!user) return {};
      return {
        userMetadata: user.userMetadata,
        appMetadata: user.appMetadata,
      };
    },

    async setUserMetadata(userId: string, data: Record<string, unknown>) {
      await AuthUser.updateOne({ _id: userId }, { $set: { userMetadata: data } });
    },

    async setAppMetadata(userId: string, data: Record<string, unknown>) {
      await AuthUser.updateOne({ _id: userId }, { $set: { appMetadata: data } });
    },

    async listUsers(query: UserQuery) {
      const filter: Record<string, unknown> = {};
      if (query.email !== undefined) filter.email = query.email;
      if (query.externalId !== undefined) filter.externalId = query.externalId;
      if (query.suspended !== undefined) filter.suspended = query.suspended;

      const startIndex = query.startIndex ?? 0;
      const count = query.count ?? 100;

      const [users, totalResults] = await Promise.all([
        AuthUser.find(filter, {
          _id: 1,
          email: 1,
          displayName: 1,
          firstName: 1,
          lastName: 1,
          externalId: 1,
          suspended: 1,
          suspendedAt: 1,
          suspendedReason: 1,
          emailVerified: 1,
          providerIds: 1,
        })
          .skip(startIndex)
          .limit(count)
          .lean(),
        AuthUser.countDocuments(filter),
      ]);

      return {
        users: (users as MongoUserDoc[]).map(u => ({
          id: String(u._id),
          email: u.email ?? undefined,
          displayName: u.displayName ?? undefined,
          firstName: u.firstName ?? undefined,
          lastName: u.lastName ?? undefined,
          externalId: u.externalId ?? undefined,
          suspended: u.suspended ?? false,
          suspendedAt: u.suspendedAt ?? undefined,
          suspendedReason: u.suspendedReason ?? undefined,
          emailVerified: u.emailVerified ?? undefined,
          providerIds: u.providerIds ?? undefined,
        })) as UserRecord[],
        totalResults,
      };
    },

    // ---------------------------------------------------------------------------
    // Groups
    // ---------------------------------------------------------------------------

    async createGroup(group) {
      try {
        await ensureIndexes();
        const doc = await Group.create(group);
        return { id: String(doc._id) };
      } catch (err: unknown) {
        if ((err as { code?: unknown }).code === 11000)
          throw new HttpError(409, 'A group with this name already exists in this scope');
        throw err;
      }
    },

    async deleteGroup(groupId) {
      await Group.findByIdAndDelete(groupId);
      await GroupMembership.deleteMany({ groupId });
    },

    async getGroup(groupId) {
      const doc = (await Group.findById(groupId).lean()) as MongoGroupDoc | null;
      if (!doc) return null;
      return mongoGroupToRecord(doc);
    },

    async listGroups(tenantId, opts) {
      const limit = Math.min(opts?.limit ?? 50, 200);
      const filter: Record<string, unknown> = { tenantId: tenantId ?? null };
      if (opts?.cursor) {
        const c = decodeCursor<MongoCursorPayload>(opts.cursor);
        if (c) {
          filter.$or = [
            { createdAt: { $gt: new Date(c.createdAt) } },
            { createdAt: new Date(c.createdAt), _id: { $gt: c.id } },
          ];
        }
      }
      const docs = (await Group.find(filter)
        .sort({ createdAt: 1, _id: 1 })
        .limit(limit + 1)
        .lean()) as unknown as MongoGroupDoc[];
      const hasMore = docs.length > limit;
      const page = hasMore ? docs.slice(0, limit) : docs;
      const lastGroup = page[page.length - 1];
      const lastTs = lastGroup.createdAt;
      const nextCursor = hasMore
        ? encodeCursor({
            createdAt: lastTs instanceof Date ? lastTs.getTime() : lastTs,
            id: String(lastGroup._id),
          })
        : undefined;
      return { items: page.map(mongoGroupToRecord), nextCursor, hasMore: !!nextCursor };
    },

    async updateGroup(groupId, updates) {
      await Group.findByIdAndUpdate(groupId, { $set: updates });
    },

    async addGroupMember(groupId, userId, roles = []) {
      const group = (await Group.findById(groupId, 'tenantId').lean()) as MongoGroupDoc | null;
      if (!group) throw new HttpError(404, 'Group not found');
      try {
        await ensureIndexes();
        await GroupMembership.create({ groupId, userId, roles, tenantId: group.tenantId ?? null });
      } catch (err: unknown) {
        if ((err as { code?: unknown }).code === 11000)
          throw new HttpError(409, 'User is already a member of this group');
        throw err;
      }
    },

    async updateGroupMembership(groupId, userId, roles) {
      await GroupMembership.findOneAndUpdate({ groupId, userId }, { $set: { roles } });
    },

    async removeGroupMember(groupId, userId) {
      await GroupMembership.deleteOne({ groupId, userId });
    },

    async getGroupMembers(groupId, opts) {
      const limit = Math.min(opts?.limit ?? 50, 200);
      const filter: Record<string, unknown> = { groupId };
      if (opts?.cursor) {
        const c = decodeCursor<MongoCursorPayload>(opts.cursor);
        if (c) {
          filter.$or = [
            { createdAt: { $gt: new Date(c.createdAt) } },
            { createdAt: new Date(c.createdAt), _id: { $gt: c.id } },
          ];
        }
      }
      const docs = (await GroupMembership.find(filter, 'userId roles createdAt')
        .sort({ createdAt: 1, _id: 1 })
        .limit(limit + 1)
        .lean()) as unknown as MongoGroupMembershipDoc[];
      const hasMore = docs.length > limit;
      const page = hasMore ? docs.slice(0, limit) : docs;
      const last = page[page.length - 1];
      const nextCursor =
        hasMore && last.createdAt
          ? encodeCursor({ createdAt: last.createdAt.getTime(), id: String(last._id) })
          : undefined;
      return {
        items: page.map(d => ({ userId: d.userId, roles: d.roles ?? [] })),
        nextCursor,
        hasMore: !!nextCursor,
      };
    },

    async getUserGroups(userId, tenantId) {
      const memberships = (await GroupMembership.find(
        { userId, tenantId: tenantId ?? null },
        'groupId roles',
      ).lean()) as MongoGroupMembershipDoc[];
      if (memberships.length === 0) return [];
      const groupIds = memberships.map(m => m.groupId);
      const groups = (await Group.find({
        _id: { $in: groupIds },
      }).lean()) as unknown as MongoGroupDoc[];
      const groupMap = new Map(groups.map(g => [String(g._id), g]));
      return memberships.flatMap((m: MongoGroupMembershipDoc) => {
        const g = groupMap.get(m.groupId);
        return g ? [{ group: mongoGroupToRecord(g), membershipRoles: m.roles ?? [] }] : [];
      });
    },

    async getEffectiveRoles(userId, tenantId) {
      let direct: string[];
      if (tenantId) {
        const doc = await TenantRole.findOne({ userId, tenantId }, 'roles').lean();
        direct = doc?.roles ?? [];
      } else {
        const user = await AuthUser.findById(userId, 'roles').lean();
        direct = user?.roles ?? [];
      }
      const memberships = (await GroupMembership.find(
        { userId, tenantId: tenantId ?? null },
        'groupId roles',
      ).lean()) as MongoGroupMembershipDoc[];
      if (memberships.length === 0) return [...new Set(direct)];
      const groupIds = memberships.map(m => m.groupId);
      const groups = (await Group.find(
        { _id: { $in: groupIds } },
        'roles',
      ).lean()) as unknown as MongoGroupDoc[];
      const groupMap = new Map(groups.map(g => [String(g._id), g.roles ?? []]));
      const groupRoles = memberships.flatMap(m => [
        ...(groupMap.get(m.groupId) ?? []),
        ...(m.roles ?? []),
      ]);
      return [...new Set([...direct, ...groupRoles])];
    },

    // ---------------------------------------------------------------------------
    // Password history
    // ---------------------------------------------------------------------------

    async getPasswordHistory(userId) {
      const user = (await AuthUser.findById(
        userId,
        'passwordHistory',
      ).lean()) as MongoUserDoc | null;
      return user?.passwordHistory ?? [];
    },

    async addPasswordToHistory(userId, hash, maxCount) {
      await AuthUser.findByIdAndUpdate(userId, {
        $push: {
          passwordHistory: {
            $each: [hash],
            $slice: -maxCount,
          },
        },
      });
    },

    // ---------------------------------------------------------------------------
    // M2M client credentials
    // ---------------------------------------------------------------------------

    async getM2MClient(clientId: string) {
      const client = await M2MClient.findOne({ clientId, active: true }).lean();
      if (!client) return null;
      return {
        id: String(client._id),
        clientId: client.clientId,
        name: client.name,
        scopes: client.scopes,
        active: client.active,
        clientSecretHash: client.clientSecretHash,
      };
    },

    async createM2MClient(data) {
      try {
        await ensureIndexes();
        const client = await M2MClient.create(data);
        return { id: String(client._id) };
      } catch (err: unknown) {
        if (isMongoDuplicateKeyError(err)) throw new HttpError(409, 'Client ID already exists');
        throw err;
      }
    },

    async deleteM2MClient(clientId: string) {
      await M2MClient.deleteOne({ clientId });
    },

    async listM2MClients() {
      const clients = (await M2MClient.find({}).lean()) as IM2MClient[];
      return clients.map(c => ({
        id: c._id,
        clientId: c.clientId,
        name: c.name,
        scopes: c.scopes,
        active: c.active,
      }));
    },
  };
  return adapter;
}
