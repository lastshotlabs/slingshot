declare module '@lastshotlabs/slingshot-core' {
  interface SlingshotEventMap {
    'community:container.created': {
      id: string;
      slug: string;
      tenantId?: string | null;
      createdBy: string;
    };
    'community:container.deleted': { id: string; tenantId?: string | null };
    'community:thread.created': {
      id: string;
      tenantId?: string | null;
      containerId: string;
      authorId: string;
      title: string;
      format: 'plain' | 'markdown';
    };
    'community:thread.updated': { id: string; tenantId?: string | null; containerId: string };
    'community:thread.deleted': { id: string; tenantId?: string | null; containerId: string };
    'community:thread.published': {
      id: string;
      tenantId?: string | null;
      containerId: string;
      authorId: string;
    };
    'community:thread.locked': { id: string; tenantId?: string | null; containerId: string };
    'community:thread.unlocked': { id: string; tenantId?: string | null; containerId: string };
    'community:thread.pinned': { id: string; tenantId?: string | null; containerId: string };
    'community:thread.unpinned': { id: string; tenantId?: string | null; containerId: string };
    'community:thread.solved': {
      id: string;
      tenantId?: string | null;
      containerId: string;
      solutionReplyId?: string | null;
    };
    'community:thread.unsolved': { id: string; tenantId?: string | null; containerId: string };
    'community:reply.created': {
      id: string;
      tenantId?: string | null;
      threadId: string;
      containerId: string;
      parentId?: string | null;
      authorId: string;
    };
    'community:reply.deleted': {
      id: string;
      tenantId?: string | null;
      threadId: string;
      containerId: string;
    };
    'community:thread.embeds.resolved': {
      id: string;
      tenantId?: string | null;
      containerId: string;
      embeds: unknown;
    };
    'community:reply.embeds.resolved': {
      id: string;
      tenantId?: string | null;
      threadId: string;
      containerId: string;
      embeds: unknown;
    };
    'community:invite.redeemed': {
      id: string;
      containerId: string;
      userId: string;
      alreadyMember?: boolean | null;
    };
    'community:reaction.added': {
      targetId: string;
      targetType: 'thread' | 'reply';
      tenantId?: string | null;
      containerId?: string | null;
      userId: string;
      type: 'upvote' | 'downvote' | 'emoji';
      value?: string | null;
    };
    'community:reaction.removed': {
      targetId: string;
      targetType: 'thread' | 'reply';
      tenantId?: string | null;
      containerId?: string | null;
      userId: string;
      type: 'upvote' | 'downvote' | 'emoji';
    };
  }
}

export {};
