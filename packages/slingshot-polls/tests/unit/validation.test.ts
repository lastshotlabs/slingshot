/**
 * Zod validation schema tests.
 *
 * Covers:
 * - PollCreateInputSchema rejects oversized question, empty options, etc.
 * - PollVoteCreateInputSchema rejects negative optionIndex
 * - PollResultsParamsSchema validates UUID
 */
import { describe, expect, it } from 'bun:test';
import { PollVoteCreateInputSchema } from '../../src/validation/pollVotes';
import { buildPollSchemas } from '../../src/validation/polls';
import { PollResultsParamsSchema } from '../../src/validation/results';

const { PollCreateInputSchema } = buildPollSchemas({
  maxOptions: 10,
  maxQuestionLength: 500,
  maxOptionLength: 200,
});

describe('PollCreateInputSchema', () => {
  const validInput = {
    sourceType: 'test:source',
    sourceId: 'source-1',
    scopeId: 'scope-1',
    question: 'What is your favorite color?',
    options: ['Red', 'Blue', 'Green'],
  };

  it('accepts valid input', () => {
    const result = PollCreateInputSchema.safeParse(validInput);
    expect(result.success).toBe(true);
  });

  it('rejects empty question', () => {
    const result = PollCreateInputSchema.safeParse({
      ...validInput,
      question: '',
    });
    expect(result.success).toBe(false);
  });

  it('rejects oversized question', () => {
    const result = PollCreateInputSchema.safeParse({
      ...validInput,
      question: 'x'.repeat(501),
    });
    expect(result.success).toBe(false);
  });

  it('rejects fewer than 2 options', () => {
    const result = PollCreateInputSchema.safeParse({
      ...validInput,
      options: ['Only one'],
    });
    expect(result.success).toBe(false);
  });

  it('rejects more than maxOptions', () => {
    const result = PollCreateInputSchema.safeParse({
      ...validInput,
      options: Array.from({ length: 11 }, (_, i) => `Option ${i}`),
    });
    expect(result.success).toBe(false);
  });

  it('rejects empty option text', () => {
    const result = PollCreateInputSchema.safeParse({
      ...validInput,
      options: ['A', '', 'C'],
    });
    expect(result.success).toBe(false);
  });

  it('rejects oversized option text', () => {
    const result = PollCreateInputSchema.safeParse({
      ...validInput,
      options: ['A', 'x'.repeat(201)],
    });
    expect(result.success).toBe(false);
  });

  it('defaults multiSelect to false', () => {
    const result = PollCreateInputSchema.parse(validInput);
    expect(result.multiSelect).toBe(false);
  });

  it('defaults anonymous to false', () => {
    const result = PollCreateInputSchema.parse(validInput);
    expect(result.anonymous).toBe(false);
  });

  it('accepts valid closesAt datetime', () => {
    const result = PollCreateInputSchema.safeParse({
      ...validInput,
      closesAt: '2030-01-01T00:00:00Z',
    });
    expect(result.success).toBe(true);
  });

  it('rejects invalid closesAt string', () => {
    const result = PollCreateInputSchema.safeParse({
      ...validInput,
      closesAt: 'not-a-date',
    });
    expect(result.success).toBe(false);
  });

  it('rejects missing sourceType', () => {
    const { sourceType: _omitSourceType, ...rest } = validInput;
    void _omitSourceType;
    const result = PollCreateInputSchema.safeParse(rest);
    expect(result.success).toBe(false);
  });

  it('rejects missing scopeId', () => {
    const { scopeId: _omitScopeId, ...rest } = validInput;
    void _omitScopeId;
    const result = PollCreateInputSchema.safeParse(rest);
    expect(result.success).toBe(false);
  });
});

describe('PollVoteCreateInputSchema', () => {
  it('accepts valid input', () => {
    const result = PollVoteCreateInputSchema.safeParse({
      pollId: '550e8400-e29b-41d4-a716-446655440000',
      optionIndex: 0,
    });
    expect(result.success).toBe(true);
  });

  it('rejects negative optionIndex', () => {
    const result = PollVoteCreateInputSchema.safeParse({
      pollId: '550e8400-e29b-41d4-a716-446655440000',
      optionIndex: -1,
    });
    expect(result.success).toBe(false);
  });

  it('rejects float optionIndex', () => {
    const result = PollVoteCreateInputSchema.safeParse({
      pollId: '550e8400-e29b-41d4-a716-446655440000',
      optionIndex: 1.5,
    });
    expect(result.success).toBe(false);
  });

  it('rejects invalid pollId (not UUID)', () => {
    const result = PollVoteCreateInputSchema.safeParse({
      pollId: 'not-a-uuid',
      optionIndex: 0,
    });
    expect(result.success).toBe(false);
  });
});

describe('PollResultsParamsSchema', () => {
  it('accepts valid UUID', () => {
    const result = PollResultsParamsSchema.safeParse({
      id: '550e8400-e29b-41d4-a716-446655440000',
    });
    expect(result.success).toBe(true);
  });

  it('rejects invalid UUID', () => {
    const result = PollResultsParamsSchema.safeParse({
      id: 'not-a-uuid',
    });
    expect(result.success).toBe(false);
  });
});
