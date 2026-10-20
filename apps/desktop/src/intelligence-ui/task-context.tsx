import { createContext, useContext } from 'react';
import { confirmationLabels, sendsToAssistant } from './task-state.mjs';

// Services are supplied by the one task Host, never by generated page data.
export const TaskContext = createContext<any>({});
export const useTask = () => useContext(TaskContext);
export function useTaskAction(plan: unknown, defaultSend = false) {
  const task = useTask();
  const submission = sendsToAssistant(plan, defaultSend);
  const confirmation = submission ? task.confirmation : null;
  return {
    confirmation, submission,
    label: confirmationLabels[confirmation as keyof typeof confirmationLabels],
    disabled: Boolean(task.disabled || confirmation),
  };
}
