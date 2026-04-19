import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { validateManifestCrossFields } from '../../src/lib/manifest/validation';

// Helper to collect issues from validateManifestCrossFields
function collectIssues(manifest: Record<string, unknown>): z.ZodIssue[] {
  const issues: z.ZodIssue[] = [];
  const ctx: z.RefinementCtx = {
    addIssue: (issue: z.IssueData) => {
      issues.push(issue as unknown as z.ZodIssue);
    },
    path: [],
  };
  validateManifestCrossFields(manifest, ctx);
  return issues;
}

describe('validateManifestCrossFields', () => {
  test('returns early with no issues when no pages defined', () => {
    const issues = collectIssues({ entities: { user: { fields: { name: {} } } } });
    expect(issues).toHaveLength(0);
  });

  test('reports unknown entity reference on page', () => {
    const issues = collectIssues({
      entities: {},
      pages: {
        userList: {
          type: 'entity-list',
          entity: 'nonexistent',
          fields: [],
          title: 'Users',
        },
      },
    });
    const entityIssue = issues.find(i => (i.path as string[]).includes('entity'));
    expect(entityIssue).toBeDefined();
    expect(entityIssue?.message as string).toContain('Unknown entity');
  });

  test('entity-list: reports unknown field ref', () => {
    const issues = collectIssues({
      entities: {
        user: { fields: { name: {}, email: {} } },
      },
      pages: {
        userList: {
          type: 'entity-list',
          entity: 'user',
          fields: ['name', 'unknownField'],
          title: 'Users',
        },
      },
    });
    const fieldIssue = issues.find(
      i => (i.message as string).includes('Unknown field "unknownField"'),
    );
    expect(fieldIssue).toBeDefined();
  });

  test('entity-list: reports unknown defaultSort field', () => {
    const issues = collectIssues({
      entities: { user: { fields: { name: {} } } },
      pages: {
        userList: {
          type: 'entity-list',
          entity: 'user',
          fields: ['name'],
          defaultSort: { field: 'missingField' },
          title: 'Users',
        },
      },
    });
    const sortIssue = issues.find(i =>
      (i.path as string[]).includes('defaultSort'),
    );
    expect(sortIssue).toBeDefined();
  });

  test('entity-list: reports unknown filter field', () => {
    const issues = collectIssues({
      entities: { user: { fields: { name: {} } } },
      pages: {
        userList: {
          type: 'entity-list',
          entity: 'user',
          fields: ['name'],
          filters: [{ field: 'badField' }],
          title: 'Users',
        },
      },
    });
    const filterIssue = issues.find(i =>
      (i.path as string[]).includes('filters'),
    );
    expect(filterIssue).toBeDefined();
  });

  test('entity-list: reports unknown rowClick page reference', () => {
    const issues = collectIssues({
      entities: { user: { fields: { name: {} } } },
      pages: {
        userList: {
          type: 'entity-list',
          entity: 'user',
          fields: ['name'],
          rowClick: 'nonexistentPage',
          title: 'Users',
        },
      },
    });
    const rowClickIssue = issues.find(i =>
      (i.path as string[]).includes('rowClick'),
    );
    expect(rowClickIssue).toBeDefined();
  });

  test('entity-list: reports unknown actions.create page reference', () => {
    const issues = collectIssues({
      entities: { user: { fields: { name: {} } } },
      pages: {
        userList: {
          type: 'entity-list',
          entity: 'user',
          fields: ['name'],
          actions: { create: 'nonexistentPage' },
          title: 'Users',
        },
      },
    });
    const actionIssue = issues.find(i =>
      (i.path as string[]).includes('create'),
    );
    expect(actionIssue).toBeDefined();
  });

  test('entity-list: valid page with known references produces no issues', () => {
    const issues = collectIssues({
      entities: { user: { fields: { name: {}, email: {} } } },
      pages: {
        userCreate: { type: 'entity-form', entity: 'user', fields: ['name'], title: 'Create' },
        userList: {
          type: 'entity-list',
          entity: 'user',
          fields: ['name'],
          rowClick: 'userCreate',
          actions: { create: 'userCreate' },
          title: 'Users',
        },
      },
    });
    expect(issues).toHaveLength(0);
  });

  test('entity-detail: reports both fields and sections defined simultaneously', () => {
    const issues = collectIssues({
      entities: { user: { fields: { name: {} } } },
      pages: {
        userDetail: {
          type: 'entity-detail',
          entity: 'user',
          fields: ['name'],
          sections: [{ fields: ['name'] }],
          title: 'User Detail',
        },
      },
    });
    const bothIssue = issues.find(i =>
      (i.message as string).includes('cannot declare both'),
    );
    expect(bothIssue).toBeDefined();
  });

  test('entity-detail: reports unknown field in sections', () => {
    const issues = collectIssues({
      entities: { user: { fields: { name: {} } } },
      pages: {
        userDetail: {
          type: 'entity-detail',
          entity: 'user',
          sections: [{ fields: ['name', 'badField'] }],
          title: 'User Detail',
        },
      },
    });
    const sectionIssue = issues.find(i =>
      (i.message as string).includes('Unknown field "badField"'),
    );
    expect(sectionIssue).toBeDefined();
  });

  test('entity-detail: reports unknown related entity', () => {
    const issues = collectIssues({
      entities: { user: { fields: { id: {} } } },
      pages: {
        userDetail: {
          type: 'entity-detail',
          entity: 'user',
          fields: [],
          related: [
            { entity: 'unknownEntity', foreignKey: 'userId', fields: [] },
          ],
          title: 'User Detail',
        },
      },
    });
    const relatedIssue = issues.find(i =>
      (i.message as string).includes('Unknown entity "unknownEntity"'),
    );
    expect(relatedIssue).toBeDefined();
  });

  test('entity-detail: reports unknown foreignKey on related entity', () => {
    const issues = collectIssues({
      entities: {
        user: { fields: { id: {} } },
        post: { fields: { title: {} } },
      },
      pages: {
        userDetail: {
          type: 'entity-detail',
          entity: 'user',
          fields: [],
          related: [
            { entity: 'post', foreignKey: 'noSuchKey', fields: ['title'] },
          ],
          title: 'User Detail',
        },
      },
    });
    const fkIssue = issues.find(i =>
      (i.message as string).includes('Unknown field "noSuchKey"'),
    );
    expect(fkIssue).toBeDefined();
  });

  test('entity-detail: reports unknown lookup operation', () => {
    const issues = collectIssues({
      entities: {
        user: { fields: { email: {} }, operations: { findByEmail: {} } },
      },
      pages: {
        userDetail: {
          type: 'entity-detail',
          entity: 'user',
          fields: [],
          lookup: 'unknownOp',
          title: 'User Detail',
        },
      },
    });
    const lookupIssue = issues.find(i =>
      (i.path as string[]).includes('lookup'),
    );
    expect(lookupIssue).toBeDefined();
  });

  test('entity-detail: lookup "id" is always valid', () => {
    const issues = collectIssues({
      entities: { user: { fields: { email: {} } } },
      pages: {
        userDetail: {
          type: 'entity-detail',
          entity: 'user',
          fields: [],
          lookup: 'id',
          title: 'User Detail',
        },
      },
    });
    const lookupIssues = issues.filter(i =>
      (i.path as string[]).includes('lookup'),
    );
    expect(lookupIssues).toHaveLength(0);
  });

  test('entity-detail: reports unknown actions.edit page reference', () => {
    const issues = collectIssues({
      entities: { user: { fields: { name: {} } } },
      pages: {
        userDetail: {
          type: 'entity-detail',
          entity: 'user',
          fields: [],
          actions: { edit: 'noSuchPage' },
          title: 'User Detail',
        },
      },
    });
    const editIssue = issues.find(i =>
      (i.path as string[]).includes('edit'),
    );
    expect(editIssue).toBeDefined();
  });

  test('entity-detail: reports unknown actions.back page reference', () => {
    const issues = collectIssues({
      entities: { user: { fields: { name: {} } } },
      pages: {
        userDetail: {
          type: 'entity-detail',
          entity: 'user',
          fields: [],
          actions: { back: 'noSuchPage' },
          title: 'User Detail',
        },
      },
    });
    const backIssue = issues.find(i =>
      (i.path as string[]).includes('back'),
    );
    expect(backIssue).toBeDefined();
  });

  test('entity-form: reports missing lookup for update operation', () => {
    const issues = collectIssues({
      entities: { user: { fields: { name: {} } } },
      pages: {
        userEdit: {
          type: 'entity-form',
          entity: 'user',
          fields: ['name'],
          operation: 'update',
          title: 'Edit User',
          // no lookup
        },
      },
    });
    const lookupIssue = issues.find(i =>
      (i.message as string).includes('require a lookup'),
    );
    expect(lookupIssue).toBeDefined();
  });

  test('entity-form: reports unknown lookup operation', () => {
    const issues = collectIssues({
      entities: {
        user: { fields: { name: {} }, operations: {} },
      },
      pages: {
        userEdit: {
          type: 'entity-form',
          entity: 'user',
          fields: ['name'],
          operation: 'update',
          lookup: 'noSuchOp',
          title: 'Edit User',
        },
      },
    });
    const lookupIssue = issues.find(i =>
      (i.path as string[]).includes('lookup'),
    );
    expect(lookupIssue).toBeDefined();
  });

  test('entity-form: reports unknown fieldConfig key', () => {
    const issues = collectIssues({
      entities: { user: { fields: { name: {} } } },
      pages: {
        userCreate: {
          type: 'entity-form',
          entity: 'user',
          fields: ['name'],
          fieldConfig: { unknownField: {} },
          title: 'Create User',
        },
      },
    });
    const configIssue = issues.find(i =>
      (i.message as string).includes('Unknown field "unknownField"'),
    );
    expect(configIssue).toBeDefined();
  });

  test('entity-dashboard: reports unknown stat entity', () => {
    const issues = collectIssues({
      entities: {},
      pages: {
        dashboard: {
          type: 'entity-dashboard',
          stats: [{ entity: 'noSuch', aggregate: 'count' }],
          title: 'Dashboard',
        },
      },
    });
    const statIssue = issues.find(i =>
      (i.message as string).includes('Unknown entity "noSuch"'),
    );
    expect(statIssue).toBeDefined();
  });

  test('entity-dashboard: reports missing field for non-count aggregate', () => {
    const issues = collectIssues({
      entities: { user: { fields: { age: {} } } },
      pages: {
        dashboard: {
          type: 'entity-dashboard',
          stats: [{ entity: 'user', aggregate: 'sum' }], // no field
          title: 'Dashboard',
        },
      },
    });
    const fieldIssue = issues.find(i =>
      (i.message as string).includes('require a field'),
    );
    expect(fieldIssue).toBeDefined();
  });

  test('entity-dashboard: reports unknown stat field', () => {
    const issues = collectIssues({
      entities: { user: { fields: { age: {} } } },
      pages: {
        dashboard: {
          type: 'entity-dashboard',
          stats: [{ entity: 'user', aggregate: 'sum', field: 'noSuchField' }],
          title: 'Dashboard',
        },
      },
    });
    const fieldIssue = issues.find(i =>
      (i.message as string).includes('Unknown field "noSuchField"'),
    );
    expect(fieldIssue).toBeDefined();
  });

  test('entity-dashboard: reports unknown activity entity', () => {
    const issues = collectIssues({
      entities: {},
      pages: {
        dashboard: {
          type: 'entity-dashboard',
          stats: [],
          activity: { entity: 'noSuch', fields: [] },
          title: 'Dashboard',
        },
      },
    });
    const activityIssue = issues.find(i =>
      (i.path as string[]).includes('activity'),
    );
    expect(activityIssue).toBeDefined();
  });

  test('entity-dashboard: reports unknown activity sortField', () => {
    const issues = collectIssues({
      entities: { user: { fields: { name: {}, createdAt: {} } } },
      pages: {
        dashboard: {
          type: 'entity-dashboard',
          stats: [],
          activity: {
            entity: 'user',
            fields: ['name'],
            sortField: 'noSuchSortField',
          },
          title: 'Dashboard',
        },
      },
    });
    const sortIssue = issues.find(i =>
      (i.message as string).includes('Unknown field "noSuchSortField"'),
    );
    expect(sortIssue).toBeDefined();
  });

  test('entity-dashboard: reports unknown chart entity', () => {
    const issues = collectIssues({
      entities: {},
      pages: {
        dashboard: {
          type: 'entity-dashboard',
          stats: [],
          chart: { entity: 'noSuch', categoryField: 'x', valueField: 'y' },
          title: 'Dashboard',
        },
      },
    });
    const chartIssue = issues.find(i =>
      (i.path as string[]).includes('chart'),
    );
    expect(chartIssue).toBeDefined();
  });

  test('entity-dashboard: reports unknown chart categoryField', () => {
    const issues = collectIssues({
      entities: { order: { fields: { status: {}, amount: {} } } },
      pages: {
        dashboard: {
          type: 'entity-dashboard',
          stats: [],
          chart: { entity: 'order', categoryField: 'noSuch', valueField: 'amount' },
          title: 'Dashboard',
        },
      },
    });
    const chartIssue = issues.find(i =>
      (i.message as string).includes('Unknown field "noSuch"'),
    );
    expect(chartIssue).toBeDefined();
  });

  test('entity-dashboard: reports unknown chart valueField', () => {
    const issues = collectIssues({
      entities: { order: { fields: { status: {}, amount: {} } } },
      pages: {
        dashboard: {
          type: 'entity-dashboard',
          stats: [],
          chart: { entity: 'order', categoryField: 'status', valueField: 'noSuch' },
          title: 'Dashboard',
        },
      },
    });
    const chartIssue = issues.find(i =>
      (i.message as string).includes('Unknown field "noSuch"'),
    );
    expect(chartIssue).toBeDefined();
  });

  test('custom page type produces no issues', () => {
    const issues = collectIssues({
      pages: {
        myCustomPage: { type: 'custom', title: 'Custom' },
      },
    });
    expect(issues).toHaveLength(0);
  });

  test('page with object title and known field produces no issues', () => {
    const issues = collectIssues({
      entities: { user: { fields: { name: {}, email: {} } } },
      pages: {
        userDetail: {
          type: 'entity-detail',
          entity: 'user',
          fields: [],
          title: { field: 'name' },
        },
      },
    });
    expect(issues).toHaveLength(0);
  });

  test('page with object title and unknown field reports issue', () => {
    const issues = collectIssues({
      entities: { user: { fields: { email: {} } } },
      pages: {
        userDetail: {
          type: 'entity-detail',
          entity: 'user',
          fields: [],
          title: { field: 'badField' },
        },
      },
    });
    const titleIssue = issues.find(i =>
      (i.path as string[]).includes('field'),
    );
    expect(titleIssue).toBeDefined();
  });

  test('page with template title and unknown placeholder reports issue', () => {
    const issues = collectIssues({
      entities: { user: { fields: { name: {} } } },
      pages: {
        userDetail: {
          type: 'entity-detail',
          entity: 'user',
          fields: [],
          title: { template: 'User: {badField}' },
        },
      },
    });
    const templateIssue = issues.find(i =>
      (i.message as string).includes('Unknown template field "badField"'),
    );
    expect(templateIssue).toBeDefined();
  });
});
