import type { HostMessage } from '../../src/types.js';

export function userMessage(text: string, id = 'user-1'): HostMessage {
  return { id, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] };
}

export function assistantMessage(text: string, id = 'asst-1'): HostMessage {
  return { id, role: 'assistant', source: { kind: 'model' }, content: [{ type: 'text', text }] };
}

export function toolMessage(text: string, id = 'tool-1'): HostMessage {
  return { id, role: 'tool', source: { kind: 'tool' }, content: [{ type: 'text', text }] };
}

export function textOf(message: HostMessage | undefined): string {
  const content = message?.content;
  return Array.isArray(content) ? content.map((block: any) => block?.text ?? '').join('') : '';
}
