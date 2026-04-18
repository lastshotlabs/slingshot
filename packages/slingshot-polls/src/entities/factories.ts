import { createEntityFactories } from '@lastshotlabs/slingshot-entity';
import { pollOperations } from '../operations/index';
import { pollVoteOperations } from '../operations/index';
import { Poll } from './poll';
import { PollVote } from './pollVote';

export const pollFactories = createEntityFactories(Poll, pollOperations.operations);

export const pollVoteFactories = createEntityFactories(PollVote, pollVoteOperations.operations);
