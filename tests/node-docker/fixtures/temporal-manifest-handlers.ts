import {
  formatProfileTaskExport,
  onboardingWorkflowExport,
  pauseTaskExport,
  retryingEmailTaskExport,
} from './temporal-definitions';

export const tasks = {
  retryingEmailTaskExport,
  formatProfileTaskExport,
  pauseTaskExport,
};

export const workflows = {
  onboardingWorkflowExport,
};
