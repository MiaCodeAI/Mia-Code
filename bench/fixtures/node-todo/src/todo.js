let nextId = 1;

export function createList() {
  return { items: [] };
}

export function addTodo(list, title, priority = 'normal') {
  if (typeof title !== 'string' || title.trim() === '') throw new Error('title is required');
  const item = { id: nextId++, title: title.trim(), priority, done: false };
  list.items.push(item);
  return item;
}

export function completeTodo(list, id) {
  const item = list.items.find((i) => i.id === id);
  if (!item) throw new Error(`no todo with id ${id}`);
  item.done = true;
  return item;
}

export function removeTodo(list, id) {
  const index = list.items.findIndex((i) => i.id === id);
  if (index === -1) throw new Error(`no todo with id ${id}`);
  return list.items.splice(index, 1)[0];
}

export function pending(list) {
  return list.items.filter((i) => !i.done);
}
