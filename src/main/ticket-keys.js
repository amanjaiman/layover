// Ticket references are workspace-scoped; prefixes alone do not identify a workspace.
export const MAX_TICKET_KEYS = 50;
const KEY = /^[A-Z0-9]{1,4}-[1-9]\d*$/i;

export function normalizeTicketKeys(keys) {
  if (!Array.isArray(keys) || !keys.length || keys.length > MAX_TICKET_KEYS) throw Error('Provide 1-50 ticket keys');
  for (const key of keys) {
    if (typeof key !== 'string' || !KEY.test(key) || !Number.isSafeInteger(Number(key.split('-')[1]))) throw Error('Invalid ticket key: ' + String(key).slice(0, 80));
  }
  return [...new Set(keys.map(key => key.toUpperCase()))];
}

/** Keep references from the full prompt, independently of its shortened display title. */
export function ticketKeysFromText(text) {
  const keys = new Set();
  for (const match of String(text || '').matchAll(/\b[A-Z0-9]{1,4}-[1-9]\d*\b/gi)) {
    if (Number.isSafeInteger(Number(match[0].split('-')[1]))) keys.add(match[0].toUpperCase());
    if (keys.size === MAX_TICKET_KEYS) break;
  }
  return [...keys];
}
