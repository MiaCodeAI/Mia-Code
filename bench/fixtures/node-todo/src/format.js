export function formatTodo(item) {
  return `${item.done ? '[x]' : '[ ]'} #${item.id} ${item.title}`;
}

export function formatList(list) {
  return list.items.map(formatTodo).join('\n');
}
