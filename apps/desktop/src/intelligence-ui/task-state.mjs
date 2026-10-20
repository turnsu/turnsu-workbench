// Only historical pages translate names. New pages persist OpenUI state as-is.
export function rendererState(document) {
  if (!document.migration) return document.data;
  return Object.fromEntries(Object.entries(document.migration.bindings)
    .filter(([, key]) => Object.hasOwn(document.data, key))
    .map(([variable, key]) => [variable, document.data[key]]));
}

export function taskValues(document, values) {
  if (!document.migration) return values;
  const editable = new Set(document.migration.fields.map(field => field.binding));
  return Object.fromEntries(Object.entries(document.migration.bindings)
    .filter(([variable, key]) => editable.has(key) && Object.hasOwn(values, variable))
    .map(([variable, key]) => [key, values[variable]]));
}

export function sendsToAssistant(plan, defaultSend = false) {
  return plan ? Boolean(plan.steps?.some(step => step.type === 'continue_conversation')) : defaultSend;
}

export function actionPlanError(plan) {
  // react-lang 1.0 evaluates action contexts before @Set and does not await
  // Host callbacks. Do not partially execute a mixed plan or confirm old data.
  if (plan?.steps?.length > 1 && plan.steps.some(step => !['set', 'reset'].includes(step.type)))
    return '这个按钮包含无法组合执行的操作。请让助手拆成独立步骤，核对后再确认。';
  return null;
}

export const confirmationLabels = {
  confirmed: '已确认',
  pending: '已确认，等待接收',
  dispatching: '正在交给助手',
  uncertain: '接收状态待核对',
};
